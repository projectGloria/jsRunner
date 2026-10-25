import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import * as vm from 'node:vm';
import type { Variable } from 'eslint-scope';
import { bindingNames, endOf, inspectScope, moduleExportName, positionAt, startOf, type ESTree, type Reference } from './scope';

// Automatic context deliberately does not use Node's module evaluator. Only the
// requested declarations and their lexical dependencies are evaluated, and only when
// their initializers provably cannot run user code.

/** A diagnostic meant for the user verbatim; the runner prints it without a stack. */
export class LoaderError extends Error {}

// `export default function () {}` and `export default class {}` are ESTree `MaybeNamed*` nodes.
type AnyNode = ESTree.Node | ESTree.MaybeNamedFunctionDeclaration | ESTree.MaybeNamedClassDeclaration;
type Declaration =
  | { kind: 'variable'; node: ESTree.VariableDeclarator; keyword: string }
  | { kind: 'function'; node: ESTree.FunctionDeclaration | ESTree.MaybeNamedFunctionDeclaration }
  | { kind: 'default'; node: AnyNode; local: string }
  | { kind: 'unsupported'; node: AnyNode; reason: string };

type ExportTarget = { local: string } | { source: string; key: string };
type Origin = { file: ModuleFile; local: string } | { builtin: string; key: string };

interface ModuleFile {
  filename: string;
  source: string;
  variables: Map<string, Variable>;
  /** Every reference in every scope, sorted by position for range lookups. */
  references: Reference[];
  declarations: Map<string, Declaration>;
  mutations: Map<string, ESTree.Statement[]>;
  imports: Map<string, { source: string; key: string }>;
  exports: Map<string, ExportTarget>;
  stars: string[];
  /** Module-level names this run needs, both local declarations and import bindings. */
  needed: Set<string>;
  origins: Map<string, Origin>;
  env?: Record<string, unknown>;
  evaluating?: boolean;
}

const importDynamically = vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER;

/**
 * Evaluates `names` from the module-level scope of `source` (the unsaved editor buffer).
 * One Loader per run: each file is parsed and evaluated at most once, so every importer
 * shares the same object identities, like real ES modules.
 */
export async function loadContext(source: string, filename: string, names: string[]): Promise<Record<string, unknown>> {
  const loader = new Loader();
  const root = loader.file(filename, source);
  // Phase 1 is synchronous: resolve the full graph before running anything.
  for (const name of names) loader.need(root, name);
  // Phase 2 evaluates each file exactly once, dependencies first.
  const env = await loader.evaluate(root);
  return Object.fromEntries(names.map(name => [name, env[name]]));
}

class Loader {
  private files = new Map<string, ModuleFile>();
  private builtins = new Map<string, Promise<Record<string, unknown>>>();

  file(filename: string, source?: string): ModuleFile {
    const cached = this.files.get(filename);
    if (cached) return cached;
    source ??= readFileSync(filename, 'utf8');
    let parsed: ReturnType<typeof inspectScope>;
    try { parsed = inspectScope(source); } catch (error) {
      throw new LoaderError(`Cannot parse ${path.basename(filename)}: ${(error as Error).message}`);
    }
    const moduleScope = parsed.scope.scopes.find(scope => scope.type === 'module')!;
    const file: ModuleFile = {
      filename, source,
      variables: moduleScope.set,
      references: parsed.scope.scopes.flatMap(scope => scope.references).sort((a, b) => startOf(a.identifier as ESTree.Identifier) - startOf(b.identifier as ESTree.Identifier)),
      declarations: new Map(), mutations: new Map(), imports: new Map(), exports: new Map(), stars: [],
      needed: new Set(), origins: new Map(),
    };
    this.files.set(filename, file);
    collect(file, parsed.ast);
    return file;
  }

  need(file: ModuleFile, name: string): void {
    if (file.needed.has(name)) return;
    file.needed.add(name);
    const binding = file.imports.get(name);
    if (binding) {
      file.origins.set(name, this.resolveImport(file, binding.source, binding.key, name, new Set()));
      return;
    }
    const declaration = file.declarations.get(name);
    if (!declaration) this.fail(file, name, 'it is not a standalone top-level declaration');
    if (declaration.kind === 'unsupported') this.fail(file, name, declaration.reason);
    if (declaration.kind !== 'function') {
      const reason = unsafe(file, declaration.kind === 'variable' ? declaration.node.init : declaration.node);
      if (reason) this.fail(file, name, reason);
    }
    // Include every module-level binding the declaration mentions, even inside function
    // bodies: closures need those bindings to exist by the time they're called.
    for (const reference of referencesWithin(file, declaration.node)) {
      const variable = file.variables.get(reference.identifier.name);
      if (variable && reference.resolved === variable) this.need(file, variable.name);
    }
    // Include top-level mutating statements (e.g. hobbies.push(...), assignments) on this variable
    const mutations = file.mutations.get(name);
    if (mutations) {
      for (const mutation of mutations) {
        const reason = unsafe(file, mutation);
        if (reason) this.fail(file, name, reason);
        for (const reference of referencesWithin(file, mutation)) {
          const variable = file.variables.get(reference.identifier.name);
          if (variable && reference.resolved === variable && variable.name !== name) {
            this.need(file, variable.name);
          }
        }
      }
    }
  }

  private resolveImport(file: ModuleFile, source: string, key: string, name: string, seen: Set<string>): Origin {
    // Built-in modules have no user code, so loading them can't run unrelated side effects.
    if (isBuiltin(source)) return { builtin: source, key };
    if (key === '*') this.fail(file, name, 'namespace imports of local files are unsupported');
    return this.resolveExport(this.file(this.resolvePath(file, source)), key, seen);
  }

  private resolveExport(file: ModuleFile, key: string, seen: Set<string>): Origin {
    const id = `${file.filename}\0${key}`;
    if (seen.has(id)) throw new LoaderError(`Circular re-export of '${key}' in ${path.basename(file.filename)}.`);
    seen.add(id);
    const target = file.exports.get(key);
    if (target && 'local' in target) {
      this.need(file, target.local);
      return { file, local: target.local };
    }
    if (target) return this.resolveImport(file, target.source, target.key, key, seen);
    // `export *` never forwards `default`. Built-in star sources are skipped: their names
    // can't be checked without importing them during planning.
    const matches = key === 'default' ? [] : file.stars.filter(source => !isBuiltin(source) && this.hasExport(this.file(this.resolvePath(file, source)), key, new Set()));
    if (matches.length > 1) this.fail(file, key, `'${key}' is exported by more than one 'export *' source, which ES modules treat as ambiguous`);
    if (!matches.length) this.fail(file, key, `missing or unsupported export '${key}'`);
    return this.resolveImport(file, matches[0], key, key, seen);
  }

  private hasExport(file: ModuleFile, key: string, seen: Set<string>): boolean {
    if (seen.has(file.filename)) return false;
    seen.add(file.filename);
    return file.exports.has(key) || file.stars.some(source => !isBuiltin(source) && this.hasExport(this.file(this.resolvePath(file, source)), key, seen));
  }

  private resolvePath(file: ModuleFile, specifier: string): string {
    if (!/^\.\.?[\\/]/.test(specifier)) {
      throw new LoaderError(`Selection-only imports support local JavaScript files and Node.js built-ins: ${specifier}. Explicitly select the import statement to use normal module execution.`);
    }
    const base = path.resolve(path.dirname(file.filename), specifier);
    // Explicit extensions are exact, as in Node. Extensionless paths follow the common bundler convention.
    const candidates = /\.m?js$/.test(base) ? [base] : [`${base}.js`, `${base}.mjs`, path.join(base, 'index.js'), path.join(base, 'index.mjs')];
    const found = candidates.find(candidate => statSync(candidate, { throwIfNoEntry: false })?.isFile());
    if (!found) {
      throw new LoaderError(`Cannot resolve "${specifier}" from ${path.basename(file.filename)}. Selection-only imports load local .js or .mjs files (tried ${candidates.map(c => path.relative(path.dirname(file.filename), c)).join(', ')}).`);
    }
    return found;
  }

  async evaluate(file: ModuleFile): Promise<Record<string, unknown>> {
    if (file.env) return file.env;
    if (file.evaluating) throw new LoaderError(`Circular automatic import is unsupported: ${file.filename}`);
    file.evaluating = true;
    const params: string[] = [], values: unknown[] = [];
    for (const [name, origin] of file.origins) { params.push(name); values.push(await this.valueOf(origin)); }
    // `require(<built-in>)` initializers need a require bound to this file.
    if (!file.needed.has('require')) { params.push('require'); values.push(createRequire(file.filename)); }
    let fn: Function;
    try {
      fn = vm.compileFunction(compileBody(file), params, { filename: file.filename, importModuleDynamically: importDynamically });
    } catch (error) {
      throw new LoaderError(`Cannot load declarations from ${path.basename(file.filename)}: ${(error as Error).message}`);
    }
    // A plain call of a strict function: `this` is undefined, as in module code.
    file.env = fn(...values) as Record<string, unknown>;
    file.evaluating = false;
    return file.env;
  }

  private async valueOf(origin: Origin): Promise<unknown> {
    if ('file' in origin) return (await this.evaluate(origin.file))[origin.local];
    let namespace = this.builtins.get(origin.builtin);
    if (!namespace) this.builtins.set(origin.builtin, namespace = import(origin.builtin));
    const exports = await namespace;
    if (origin.key === '*') return exports;
    if (!(origin.key in exports)) throw new LoaderError(`Module ${origin.builtin} does not export '${origin.key}'.`);
    return exports[origin.key];
  }

  private fail(file: ModuleFile, name: string, reason: string): never {
    throw new LoaderError(`Cannot load '${name}' from ${path.basename(file.filename)} without running initialization: ${reason}. Include its declaration or import statement in the selection to run it as written.`);
  }
}

function collect(file: ModuleFile, ast: ESTree.Program) {
  let defaultLocal = '__jsRunnerDefault';
  while (file.source.includes(defaultLocal)) defaultLocal += '_';
  const record = (node: AnyNode) => {
    if (node.type === 'VariableDeclaration') {
      for (const declarator of node.declarations) {
        if (declarator.id.type === 'Identifier') file.declarations.set(declarator.id.name, { kind: 'variable', node: declarator, keyword: node.kind });
        else for (const name of bindingNames(declarator.id)) file.declarations.set(name, { kind: 'unsupported', node: declarator, reason: 'destructuring declarations are unsupported' });
      }
    } else if (node.type === 'FunctionDeclaration' && node.id) {
      file.declarations.set(node.id.name, { kind: 'function', node });
    } else if (node.type === 'ClassDeclaration' && node.id) {
      file.declarations.set(node.id.name, { kind: 'unsupported', node, reason: 'class declarations are unsupported' });
    }
  };
  for (const statement of ast.body) {
    switch (statement.type) {
      case 'ImportDeclaration':
        for (const specifier of statement.specifiers) {
          const key = specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.type === 'ImportNamespaceSpecifier' ? '*' : moduleExportName(specifier.imported);
          file.imports.set(specifier.local.name, { source: String(statement.source.value), key });
        }
        break;
      case 'ExportNamedDeclaration':
        if (statement.declaration) {
          record(statement.declaration);
          const declared = statement.declaration.type === 'VariableDeclaration' ? statement.declaration.declarations.flatMap(d => bindingNames(d.id)) : statement.declaration.id ? [statement.declaration.id.name] : [];
          for (const name of declared) file.exports.set(name, { local: name });
        }
        for (const specifier of statement.specifiers) {
          const local = moduleExportName(specifier.local);
          file.exports.set(moduleExportName(specifier.exported), statement.source ? { source: String(statement.source.value), key: local } : { local });
        }
        break;
      case 'ExportDefaultDeclaration': {
        const declaration = statement.declaration;
        if (declaration.type === 'Identifier') file.exports.set('default', { local: declaration.name });
        else if ((declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id) {
          record(declaration);
          file.exports.set('default', { local: declaration.id.name });
        } else {
          file.exports.set('default', { local: defaultLocal });
          file.declarations.set(defaultLocal, declaration.type === 'ClassDeclaration'
            ? { kind: 'unsupported', node: declaration, reason: 'class declarations are unsupported' }
            : { kind: 'default', node: declaration, local: defaultLocal });
        }
        break;
      }
      case 'ExportAllDeclaration':
        if (statement.exported) file.exports.set(moduleExportName(statement.exported), { source: String(statement.source.value), key: '*' });
        else file.stars.push(String(statement.source.value));
        break;
      default:
        if (statement.type === 'ExpressionStatement') {
          const expr = statement.expression;
          let target: string | null = null;
          if (expr.type === 'CallExpression' && expr.callee.type === 'MemberExpression') {
            target = rootName(expr.callee.object);
          } else if (expr.type === 'AssignmentExpression') {
            target = rootName(expr.left);
          } else if (expr.type === 'UpdateExpression') {
            target = rootName(expr.argument);
          }
          if (target && file.variables.has(target)) {
            if (!file.mutations.has(target)) file.mutations.set(target, []);
            file.mutations.get(target)!.push(statement);
            break;
          }
        }
        record(statement);
    }
  }
}

function referencesWithin(file: ModuleFile, node: AnyNode): Reference[] {
  const [start, end] = node.range!;
  // Binary search for the first reference at or after `start`.
  let low = 0, high = file.references.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (startOf(file.references[mid].identifier as ESTree.Identifier) < start) low = mid + 1; else high = mid;
  }
  const result: Reference[] = [];
  for (let i = low; i < file.references.length && endOf(file.references[i].identifier as ESTree.Identifier) <= end; i++) result.push(file.references[i]);
  return result;
}

function rootName(node: ESTree.Node): string | null {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') return rootName(node.object);
  return null;
}

/**
 * Emits the needed declarations and mutation statements in source order, each at its original line, so that
 * stack traces point at real lines and TDZ errors match what the module itself would throw.
 */
function compileBody(file: ModuleFile): string {
  const declarations = [...file.needed].filter(name => !file.origins.has(name)).map(name => file.declarations.get(name)!);
  const mutations = [...file.needed].flatMap(name => file.mutations.get(name) ?? []);
  type Entry = { node: AnyNode; prefix: string; text: string };
  const entries: Entry[] = [
    ...[...new Set(declarations)].map(d => {
      const snip = snippet(file, d);
      return { node: d.node, prefix: snip.prefix, text: snip.text + ';' };
    }),
    ...[...new Set(mutations)].map(m => {
      let t = file.source.slice(startOf(m), endOf(m));
      if (!t.endsWith(';')) t += ';';
      return { node: m, prefix: '', text: t };
    }),
  ];
  entries.sort((a, b) => startOf(a.node) - startOf(b.node));

  let body = '"use strict";', line = 1;
  for (const entry of entries) {
    const position = positionAt(file.source, startOf(entry.node));
    if (position.line > line) {
      body += '\n'.repeat(position.line - line) + ' '.repeat(Math.max(0, position.column - entry.prefix.length));
      line = position.line;
    } else body += ' ';
    body += entry.prefix + entry.text;
    line += entry.text.split('\n').length - 1;
  }
  return body + `\nreturn { ${[...file.needed].join(', ')} };`;
}

function snippet(file: ModuleFile, declaration: Declaration): { prefix: string; text: string } {
  const text = file.source.slice(startOf(declaration.node), endOf(declaration.node));
  switch (declaration.kind) {
    case 'variable': return { prefix: `${declaration.keyword} `, text };
    case 'default': return { prefix: `const ${declaration.local} = (`, text: text + ')' };
    default: return { prefix: '', text };
  }
}

const isGlobal = (file: ModuleFile, name: string) => !file.variables.has(name);

/** Returns why evaluating `node` could run user code, or null when it provably can't. */
function unsafe(file: ModuleFile, node: AnyNode | null | undefined): string | null {
  if (!node) return null;
  switch (node.type) {
    case 'Literal': case 'Identifier': case 'FunctionExpression': case 'ArrowFunctionExpression': case 'FunctionDeclaration':
      return null;
    case 'TemplateLiteral':
      return node.expressions.length ? 'computed template' : null;
    case 'ArrayExpression':
      for (const element of node.elements) {
        // Spreading iterates; only built-in iterators are reachable from validated values.
        const reason = unsafe(file, element?.type === 'SpreadElement' ? element.argument : element);
        if (reason) return reason;
      }
      return null;
    case 'ObjectExpression':
      for (const property of node.properties) {
        if (property.type === 'SpreadElement') {
          const reason = unsafe(file, property.argument);
          if (reason) return reason;
          continue;
        }
        if (property.kind !== 'init') return 'getters or setters';
        if (property.computed && !primitive(file, property.key)) return 'computed property key';
        const reason = unsafe(file, property.value);
        if (reason) return reason;
      }
      return null;
    // ToBoolean and typeof never invoke user code; numeric/string coercion can (valueOf/toString).
    case 'UnaryExpression':
      if (node.operator === 'delete') return 'delete expression';
      if (node.operator === '!' || node.operator === 'typeof' || node.operator === 'void') return unsafe(file, node.argument);
      return primitive(file, node.argument) ? null : 'operator coercing a non-primitive operand';
    case 'BinaryExpression':
      if (node.operator === '===' || node.operator === '!==') return unsafe(file, node.left) ?? unsafe(file, node.right);
      return primitive(file, node) ? null : 'operator coercing a non-primitive operand';
    case 'LogicalExpression':
      return unsafe(file, node.left) ?? unsafe(file, node.right);
    case 'ConditionalExpression':
      return unsafe(file, node.test) ?? unsafe(file, node.consequent) ?? unsafe(file, node.alternate);
    case 'MemberExpression':
      // Validated objects have no user getters, and globals are still pristine here.
      if (node.object.type === 'Super') return 'super';
      if (node.computed && !primitive(file, node.property)) return 'computed member access';
      return unsafe(file, node.object);
    case 'ChainExpression':
      return unsafe(file, node.expression);
    case 'CallExpression': {
      if (node.callee.type === 'MemberExpression' && node.callee.property.type === 'Identifier') {
        const method = node.callee.property.name;
        const SAFE_MUTATING_METHODS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'fill', 'reverse', 'sort', 'set', 'add', 'delete', 'clear']);
        if (SAFE_MUTATING_METHODS.has(method)) {
          const objReason = unsafe(file, node.callee.object);
          if (objReason) return objReason;
          for (const arg of node.arguments) {
            const argReason = unsafe(file, arg.type === 'SpreadElement' ? arg.argument : arg);
            if (argReason) return argReason;
          }
          return null;
        }
      }
      const callee = globalName(file, node.callee);
      if (node.arguments.some(argument => argument.type === 'SpreadElement')) return 'CallExpression';
      if (callee === 'Object.freeze') return node.arguments.length <= 1 ? unsafe(file, node.arguments[0] as ESTree.Expression) : 'CallExpression';
      // Symbol descriptions are coerced to strings, so only primitives are safe.
      if (callee === 'Symbol' || callee === 'Symbol.for') return node.arguments.every(argument => primitive(file, argument)) ? null : 'CallExpression';
      if (callee === 'require') {
        const [argument] = node.arguments;
        return node.arguments.length === 1 && argument.type === 'Literal' && typeof argument.value === 'string' && isBuiltin(argument.value) ? null : 'require() of a non-built-in module';
      }
      return 'CallExpression';
    }
    case 'AssignmentExpression':
      return unsafe(file, node.left) ?? unsafe(file, node.right);
    case 'UpdateExpression':
      return unsafe(file, node.argument);
    case 'ExpressionStatement':
      return unsafe(file, node.expression);
    case 'NewExpression': {
      const callee = globalName(file, node.callee);
      if ((callee === 'Map' || callee === 'Set') && node.arguments.length <= 1 && node.arguments[0]?.type !== 'SpreadElement') {
        return unsafe(file, node.arguments[0] as ESTree.Expression | undefined);
      }
      return 'NewExpression';
    }
    default:
      return node.type;
  }
}

/**
 * True when coercing `node`'s value to a primitive can't invoke user code: it's already a
 * primitive, or it's reached from an unshadowed global (`Math.PI`). No user code has run
 * when the loader evaluates, so everything reachable from globals is still built-in.
 */
function primitive(file: ModuleFile, node: ESTree.Node): boolean {
  if (pristine(file, node)) return true;
  switch (node.type) {
    case 'Literal': return true;
    case 'TemplateLiteral': return node.expressions.length === 0;
    case 'UnaryExpression':
      if (node.operator === 'delete') return false;
      if (node.operator === '!' || node.operator === 'typeof' || node.operator === 'void') return unsafe(file, node.argument) === null;
      return primitive(file, node.argument);
    case 'BinaryExpression':
      if (node.left.type === 'PrivateIdentifier') return false;
      if (node.operator === '===' || node.operator === '!==') return unsafe(file, node.left) === null && unsafe(file, node.right) === null;
      return primitive(file, node.left) && primitive(file, node.right);
    case 'LogicalExpression': return primitive(file, node.left) && primitive(file, node.right);
    case 'ConditionalExpression': return unsafe(file, node.test) === null && primitive(file, node.consequent) && primitive(file, node.alternate);
    default: return false;
  }
}

/** An unshadowed global, or a non-computed property chain rooted at one. */
function pristine(file: ModuleFile, node: ESTree.Node): boolean {
  if (node.type === 'Identifier') return isGlobal(file, node.name);
  return node.type === 'MemberExpression' && !node.computed && node.object.type !== 'Super' && pristine(file, node.object);
}

/** `Object.freeze` / `Symbol` style callee names, only when the root isn't shadowed by the module. */
function globalName(file: ModuleFile, node: ESTree.Node): string | undefined {
  if (node.type === 'Identifier') return isGlobal(file, node.name) ? node.name : undefined;
  if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.property.type === 'Identifier' && isGlobal(file, node.object.name)) {
    return `${node.object.name}.${node.property.name}`;
  }
  return undefined;
}
