import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import * as vm from 'node:vm';
import type { Variable } from 'eslint-scope';
import { bindingNames, endOf, inspectScope, lineIndex, moduleExportName, parentsOf, positionAt, startOf, type ESTree, type Reference } from './scope';
import { Builder, sourceMaps, type Segment } from './builder';

// Automatic context deliberately does not use Node's module evaluator. Only the requested
// declarations, their lexical dependencies, and provably inert updates to them are
// evaluated, and only when none of that can run user code. Every other top-level statement
// that could change a loaded value is skipped *and reported*, so a result is never silently
// built from a partial replay.

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

/** How code uses a binding. Only `escape` and `write` can change what an object holds. */
type Usage = 'read' | 'call' | 'coerce' | 'escape' | 'write';
const RANK: Record<Usage, number> = { read: 0, call: 1, coerce: 2, escape: 3, write: 4 };

/** What can change a binding's value, which decides which skipped statements matter. */
type BindingKind =
  | 'immutable' // const holding a primitive: nothing can change it
  | 'function'  // only reassignment or property writes change a function
  | 'builtin'   // a Node.js built-in: only property writes count, not calls like fs.mkdirSync()
  | 'object'    // any method call on it, or any place it escapes to, may mutate it
  | 'imported'; // an object from a local module: code running in other modules may mutate it

interface Closure { usage: Map<string, Usage>; callsOut: boolean }

interface ModuleFile {
  filename: string;
  source: string;
  /** Root document: statements ending after this offset are the selection or come after it. */
  cutoff: number;
  variables: Map<string, Variable>;
  /** Every reference in every scope, sorted by position for range lookups. */
  references: Reference[];
  parents: Map<ESTree.Node, ESTree.Node>;
  declarations: Map<string, Declaration>;
  /** Top-level code that runs when the module loads, in source order. */
  statements: AnyNode[];
  /** Statements that are provably inert updates of one binding, keyed to that binding. */
  replays: Map<AnyNode, string>;
  /** Replays this run emits: those of needed bindings, before the cutoff. */
  approved: Set<AnyNode>;
  imports: Map<string, { source: string; key: string }>;
  exports: Map<string, ExportTarget>;
  stars: string[];
  /** Module-level names this run needs, both local declarations and import bindings. */
  needed: Set<string>;
  origins: Map<string, Origin>;
  closures: Map<AnyNode, Closure>;
  env?: Record<string, unknown>;
  evaluating?: boolean;
}

const importDynamically = vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER;
// Same message V8 uses for `const` and import bindings.
const constantAssignment = () => { throw new TypeError('Assignment to constant variable.'); };

/** A replacement of `source[from, to)`; `rank` orders insertions at the same offset. */
export interface Edit { from: number; to: number; text: string; rank: number }

/** The selection, compiled inside the root file's function as an async function at its own position. */
export interface SelectionPiece {
  start: number;
  end: number;
  /** In document offsets: blanked imports, the result `return`, calls to imports. */
  edits: Edit[];
  /** The selection's own import statements, as `await import()` code. */
  prelude: string;
  /** Before the closing brace: a newline when the selection ends inside a line comment. */
  close: string;
  /** Names the selection uses freely that aren't the root bindings of the same name; see compileFile. */
  shadowed: string[];
}

/**
 * Plans and evaluates module-level declarations from the editor buffer (the root) and the
 * local files it imports. One Loader per run: each file is parsed and evaluated at most
 * once, so every importer shares the same object identities, as with real ES modules.
 *
 * Phase 1 (`need`) is synchronous: the full graph is resolved and validated before anything
 * runs. Phase 2 (`compileRoot`) evaluates dependencies first, then the root with the selection.
 */
export class Loader {
  private files = new Map<string, ModuleFile>();
  private builtins = new Map<string, Promise<Record<string, unknown>>>();
  private skipped = new Map<string, { file: ModuleFile; statement: AnyNode; names: Set<string> }>();

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
      filename, source, cutoff: Infinity,
      variables: moduleScope.set,
      references: parsed.scope.scopes.flatMap(scope => scope.references).sort((a, b) => startOf(a.identifier as ESTree.Identifier) - startOf(b.identifier as ESTree.Identifier)),
      parents: parentsOf(parsed.ast),
      declarations: new Map(), statements: [], replays: new Map(), approved: new Set(),
      imports: new Map(), exports: new Map(), stars: [],
      needed: new Set(), origins: new Map(), closures: new Map(),
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
    } else {
      const declaration = file.declarations.get(name);
      if (!declaration) this.fail(file, name, 'it is not a standalone top-level declaration');
      if (declaration.kind === 'unsupported') this.fail(file, name, declaration.reason);
      if (declaration.kind !== 'function') {
        const reason = unsafe(file, declaration.kind === 'variable' ? declaration.node.init : declaration.node);
        if (reason) this.fail(file, name, reason);
      }
      // Include every module-level binding the declaration mentions, even inside function
      // bodies: closures need those bindings to exist by the time they're called.
      for (const reference of referencesWithin(file, declaration.node)) this.needReference(file, reference);
      // Replay the binding's inert updates that ran before the selection (all of them in a
      // dependency). The selection's own statements run once, from the selection, and
      // statements below it haven't happened yet.
      for (const [statement, target] of file.replays) {
        if (target !== name || endOf(statement) > file.cutoff) continue;
        file.approved.add(statement);
        for (const reference of referencesWithin(file, statement)) this.needReference(file, reference);
      }
    }
  }

  private needReference(file: ModuleFile, reference: Reference) {
    const variable = file.variables.get(reference.identifier.name);
    if (variable && reference.resolved === variable) this.need(file, variable.name);
  }

  /** Records skipped statements that may change `name` before the selection uses it. */
  private audit(file: ModuleFile, name: string) {
    const kind = this.kindOf(file, name);
    if (kind === 'immutable') return;
    for (const statement of file.statements) {
      // Source order: once one ends past the cutoff, every later one does too.
      if (endOf(statement) > file.cutoff) break;
      if (file.replays.has(statement)) continue; // inert: it can only change its own target
      for (const effect of effects(file, statement)) {
        const closure = this.closure(file, effect);
        const usage = closure.usage.get(name);
        const changes = kind === 'function' || kind === 'builtin'
          ? usage === 'write'
          : usage === 'write' || usage === 'escape' || (kind === 'imported' && closure.callsOut);
        if (!changes) continue;
        const key = `${file.filename}\0${startOf(statement)}`;
        const entry = this.skipped.get(key) ?? { file, statement, names: new Set<string>() };
        entry.names.add(name);
        this.skipped.set(key, entry);
      }
    }
  }

  private kindOf(file: ModuleFile, name: string): BindingKind {
    const origin = file.origins.get(name);
    if (origin) {
      if (!('file' in origin)) return 'builtin';
      const kind = this.kindOf(origin.file, origin.local);
      return kind === 'object' ? 'imported' : kind;
    }
    const declaration = file.declarations.get(name);
    if (!declaration || declaration.kind === 'unsupported') return 'object';
    if (declaration.kind === 'function') return 'function';
    const value = declaration.kind === 'variable' ? declaration.node.init : declaration.node;
    const constant = declaration.kind === 'default' || declaration.keyword === 'const';
    if (constant && value && isFunctionNode(value)) return 'function';
    if (constant && value && primitive(file, value as ESTree.Node)) return 'immutable';
    return 'object';
  }

  /**
   * Bindings `start` may touch when it runs, following called functions and escaped objects
   * through their declarations (transitively), and whether it may run another module's code.
   */
  private closure(file: ModuleFile, start: AnyNode): Closure {
    const cached = file.closures.get(start);
    if (cached) return cached;
    const usage = new Map<string, Usage>();
    let callsOut = false;
    const expanded = new Set<string>();
    const queue = [start];
    while (queue.length) {
      for (const reference of referencesWithin(file, queue.pop()!)) {
        // `const f = …` initializes f; that's not a later change to it.
        if ((reference as Reference & { init?: boolean }).init) continue;
        const variable = file.variables.get(reference.identifier.name);
        if (!variable || reference.resolved !== variable) continue;
        const name = variable.name, use = usageOf(file, reference);
        if (RANK[use] >= RANK[usage.get(name) ?? 'read']) usage.set(name, use);
        // A read runs none of the binding's code; anything else may (a call, valueOf, or a
        // method on an object that escaped).
        if (use === 'read') continue;
        const imported = file.imports.get(name);
        if (imported) {
          // Calling into, coercing, or handing off another module's value may run that module's
          // code, which can change its other exports. A built-in collection's methods can't.
          if (!isBuiltin(imported.source) && !this.importedCollection(file, name)) callsOut = true;
          continue;
        }
        if (expanded.has(name)) continue;
        expanded.add(name);
        const declaration = file.declarations.get(name);
        if (declaration) queue.push(declaration.node);
        // Replays can alias: `ys.push(xs)` makes xs reachable through ys.
        for (const [statement, target] of file.replays) if (target === name) queue.push(statement);
      }
    }
    const closure = { usage, callsOut };
    file.closures.set(start, closure);
    return closure;
  }

  /** An import resolved to a const Array/Map/Set literal: every method on it is built-in. */
  private importedCollection(file: ModuleFile, name: string): boolean {
    // Unresolved means not needed this run; assume the worst.
    const origin = file.origins.get(name);
    if (!origin || !('file' in origin)) return false;
    const declaration = origin.file.declarations.get(origin.local);
    if (declaration?.kind === 'default') {
      const node = declaration.node;
      return node.type === 'ArrayExpression' || (node.type === 'NewExpression' && ['Map', 'Set'].includes(globalName(origin.file, node.callee) ?? ''));
    }
    const kind = collectionKind(origin.file, origin.local);
    return kind === 'Array' || kind === 'Map' || kind === 'Set';
  }

  /** Skipped statements that may change what the selection uses, once the whole graph is resolved. */
  notes(): string[] {
    for (const file of this.files.values()) for (const name of file.needed) this.audit(file, name);
    if (!this.skipped.size) return [];
    const entries = [...this.skipped.values()];
    const lines = entries.slice(0, 5).map(({ file, statement, names }) => {
      const { line } = positionAt(file.source, startOf(statement));
      const text = file.source.slice(startOf(statement), endOf(statement)).replace(/\s+/g, ' ').trim();
      return `  ${path.basename(file.filename)}:${line}  ${text.length > 60 ? `${text.slice(0, 57)}...` : text}  (may change ${[...names].join(', ')})`;
    });
    if (entries.length > 5) lines.push(`  ...and ${entries.length - 5} more`);
    return [`Note: automatic context skipped these top-level statements, which may change values the selection uses. Select them too if they matter:\n${lines.join('\n')}`];
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

  /**
   * Imports reach a module's code through a `with` scope of getters, so every access reads the
   * exporter's current binding: ES imports are live (`export let n` + `inc()`). Calls to them
   * are compiled as `(0, f)()`, so `this` stays undefined instead of becoming that scope object.
   */
  private async importsOf(file: ModuleFile): Promise<object> {
    const imports: PropertyDescriptorMap = {};
    for (const [name, origin] of file.origins) {
      if ('file' in origin) {
        const env = await this.evaluate(origin.file);
        imports[name] = { get: () => env[origin.local], set: constantAssignment, enumerable: true };
      } else {
        const value = await this.builtin(origin);
        imports[name] = { get: () => value, set: constantAssignment, enumerable: true };
      }
    }
    return Object.create(null, imports);
  }

  /** Evaluates a dependency once, returning live accessors for the bindings importers need. */
  private async evaluate(file: ModuleFile): Promise<Record<string, unknown>> {
    if (file.env) return file.env;
    if (file.evaluating) throw new LoaderError(`Circular automatic import is unsupported: ${path.basename(file.filename)}`);
    file.evaluating = true;
    const imports = await this.importsOf(file);
    const factory = compile(file.filename, compileFile(file, file.source), ['__jsRunnerImports', 'require'], true);
    // Called from here, not from generated code, so no generated line appears in stack traces.
    file.env = factory(imports, createRequire(file.filename))() as Record<string, unknown>;
    file.evaluating = false;
    return file.env;
  }

  /**
   * Compiles the root document's needed declarations with the selection inside the same
   * function, so the selection shares their bindings lexically: live values, real `const`
   * errors, and `this` all behave exactly as in the module. Returns the selection's function.
   */
  async compileRoot(root: ModuleFile | undefined, document: string, filename: string, selection: SelectionPiece): Promise<() => Promise<unknown[] | undefined>> {
    const imports = root ? await this.importsOf(root) : Object.create(null);
    const factory = compile(filename, compileFile(root, document, selection), ['__jsRunnerImports', 'require', 'module', 'exports', '__filename', '__dirname'], false);
    const require = createRequire(filename);
    const module = { exports: {}, filename, id: '.', path: path.dirname(filename), require };
    return factory(imports, require, module, module.exports, filename, path.dirname(filename))() as () => Promise<unknown[] | undefined>;
  }

  private async builtin(origin: { builtin: string; key: string }): Promise<unknown> {
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

/** A name not occurring in `source`, so generated declarations can't collide with user code. */
function unique(source: string, base: string) {
  let name = base;
  while (source.includes(name)) name += '_';
  return name;
}

function collect(file: ModuleFile, ast: ESTree.Program) {
  const defaultLocal = unique(file.source, '__jsRunnerDefault');
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
  // Function declarations only define; everything else here runs when the module loads.
  const runs = (node: AnyNode) => { if (node.type !== 'FunctionDeclaration') file.statements.push(node); };
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
          runs(statement.declaration);
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
        runs(declaration);
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
        record(statement);
        runs(statement);
    }
  }
  // Classified after every declaration is known: a replay's safety depends on its target's initializer.
  for (const statement of file.statements) {
    const target = replayTarget(file, statement);
    if (target) file.replays.set(statement, target);
  }
}

/** The parts of a top-level statement that can run user code or write; inert parts change nothing. */
function effects(file: ModuleFile, statement: AnyNode): AnyNode[] {
  if (statement.type === 'VariableDeclaration') return statement.declarations.flatMap(d => d.init && unsafe(file, d.init) ? [d.init] : []);
  if (statement.type === 'ExpressionStatement') return unsafe(file, statement.expression) ? [statement.expression] : [];
  if (isExpression(statement)) return unsafe(file, statement) ? [statement] : [];
  return [statement];
}

// Methods that call no user code on a built-in receiver: no callbacks, no argument coercion.
const REPLAYABLE_METHODS: Record<string, Set<string>> = {
  Array: new Set(['push', 'unshift', 'pop', 'shift', 'reverse']),
  Map: new Set(['set', 'delete', 'clear']),
  Set: new Set(['add', 'delete', 'clear']),
};

/** The binding a top-level statement updates, when replaying it provably can't run user code. */
function replayTarget(file: ModuleFile, statement: AnyNode): string | undefined {
  if (statement.type !== 'ExpressionStatement') return;
  const e = statement.expression;
  if (e.type === 'CallExpression' && e.callee.type === 'MemberExpression' && !e.callee.computed && e.callee.object.type === 'Identifier' && e.callee.property.type === 'Identifier') {
    // list.push(v), map.set(k, v), set.add(v) on a const built-in collection. Nothing can have
    // replaced the method: replays never assign properties of collections.
    const methods = REPLAYABLE_METHODS[collectionKind(file, e.callee.object.name) ?? ''];
    return methods?.has(e.callee.property.name) && e.arguments.every(a => a.type !== 'SpreadElement' && !unsafe(file, a)) ? e.callee.object.name : undefined;
  }
  if (e.type === 'AssignmentExpression' && e.operator === '=' && e.left.type === 'Identifier') {
    // x = value: rebinding a let/var.
    const declaration = file.declarations.get(e.left.name);
    return declaration?.kind === 'variable' && declaration.keyword !== 'const' && !unsafe(file, e.right) ? e.left.name : undefined;
  }
  if (e.type === 'AssignmentExpression' && e.operator === '=' && e.left.type === 'MemberExpression' && e.left.object.type === 'Identifier') {
    // obj.key = value on a const object literal: literals with accessors never load, and the
    // prototype is Object.prototype, so there's no setter to run. `__proto__` would swap it.
    const key = staticKey(e.left);
    return collectionKind(file, e.left.object.name) === 'Object' && key !== undefined && key !== '__proto__' && !unsafe(file, e.right) ? e.left.object.name : undefined;
  }
  // count++, total += 2 on a let/var that only ever holds primitives: no valueOf to call.
  const counter = e.type === 'UpdateExpression' ? e.argument : e.type === 'AssignmentExpression' && e.operator !== '=' && primitive(file, e.right) ? e.left : undefined;
  return counter?.type === 'Identifier' && primitiveVariable(file, counter.name) ? counter.name : undefined;
}

/** A let/var whose initializer and every replayable plain assignment are primitives. */
function primitiveVariable(file: ModuleFile, name: string): boolean {
  const declaration = file.declarations.get(name);
  if (declaration?.kind !== 'variable' || declaration.keyword === 'const') return false;
  if (declaration.node.init && !primitive(file, declaration.node.init)) return false;
  return file.statements.every(statement => {
    if (statement.type !== 'ExpressionStatement') return true;
    const e = statement.expression;
    return !(e.type === 'AssignmentExpression' && e.left.type === 'Identifier' && e.left.name === name) || e.operator !== '=' || primitive(file, e.right);
  });
}

/** Built-in shape of a const binding, from its initializer: the receivers replays may touch. */
function collectionKind(file: ModuleFile, name: string): 'Array' | 'Map' | 'Set' | 'Object' | undefined {
  const declaration = file.declarations.get(name);
  if (declaration?.kind !== 'variable' || declaration.keyword !== 'const') return;
  const init = declaration.node.init;
  if (init?.type === 'ArrayExpression') return 'Array';
  // `{ __proto__: x }` makes x the prototype, whose setters a property write could reach.
  if (init?.type === 'ObjectExpression') return init.properties.some(p => p.type === 'Property' && !p.computed && staticKey(p) === '__proto__') ? undefined : 'Object';
  if (init?.type === 'NewExpression') {
    const callee = globalName(file, init.callee);
    if (callee === 'Map' || callee === 'Set') return callee;
  }
}

/** Iterating this can only use a built-in iterator: a literal, a primitive, or a const collection. */
function builtinIterable(file: ModuleFile, node: ESTree.Node): boolean {
  if (node.type === 'ArrayExpression' || primitive(file, node)) return true;
  if (node.type !== 'Identifier') return false;
  const kind = collectionKind(file, node.name);
  return kind === 'Array' || kind === 'Map' || kind === 'Set';
}

function staticKey(node: ESTree.MemberExpression | ESTree.Property): string | undefined {
  const key = node.type === 'MemberExpression' ? node.property : node.key;
  if (!node.computed && key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && (typeof key.value === 'string' || typeof key.value === 'number')) return String(key.value);
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

/** How the code around a reference uses the binding, from its syntactic context. */
function usageOf(file: ModuleFile, reference: Reference): Usage {
  if (reference.isWrite()) return 'write'; // x = …, x++, for (x of …), [x] = …
  const identifier = reference.identifier as ESTree.Identifier;
  // Climb the member chain rooted at the binding: x.a.b, x?.a
  let node: ESTree.Node = identifier, parent = file.parents.get(identifier);
  while (parent && ((parent.type === 'MemberExpression' && parent.object === node) || parent.type === 'ChainExpression')) {
    node = parent;
    parent = file.parents.get(parent);
  }
  const member = node !== identifier;
  if (!parent) return 'read';
  switch (parent.type) {
    case 'AssignmentExpression': return parent.left === node ? 'write' : 'escape';
    case 'UpdateExpression': return 'write';
    case 'UnaryExpression':
      if (parent.operator === 'delete') return 'write';
      return parent.operator === 'typeof' || parent.operator === 'void' || parent.operator === '!' ? 'read' : 'coerce';
    case 'CallExpression': case 'NewExpression':
      if (parent.callee === node) return member ? 'escape' : 'call'; // x.m() may mutate x; x() runs x
      // Assumed: console methods don't change program state (they may call a custom inspect).
      return consoleCall(file, parent) ? 'read' : 'escape';
    case 'TaggedTemplateExpression': return parent.tag === node && !member ? 'call' : 'escape';
    case 'MemberExpression': return 'coerce'; // a computed key, obj[x]
    case 'BinaryExpression': return parent.operator === '===' || parent.operator === '!==' ? 'read' : 'coerce';
    case 'TemplateLiteral': return 'coerce';
    case 'ConditionalExpression': return parent.test === node ? 'read' : 'escape';
    case 'SequenceExpression': return parent.expressions.at(-1) === node ? 'escape' : 'read';
    case 'IfStatement': case 'WhileStatement': case 'DoWhileStatement': case 'SwitchStatement': case 'SwitchCase': case 'ExpressionStatement':
      return 'read';
    case 'ForStatement': return parent.init === node ? 'escape' : 'read';
    case 'ForInStatement': return parent.left === node ? 'write' : 'read'; // only keys come out
    case 'ForOfStatement': return parent.left === node ? 'write' : 'escape'; // elements come out
    case 'Property':
      if (parent.computed && parent.key === node) return 'coerce';
      return file.parents.get(parent)?.type === 'ObjectPattern' ? 'write' : 'escape';
    case 'ArrayPattern': case 'RestElement': return 'write';
    case 'AssignmentPattern': return parent.left === node ? 'write' : 'escape';
    default: return 'escape'; // returned, stored, spread, awaited, yielded…
  }
}

function consoleCall(file: ModuleFile, call: ESTree.CallExpression | ESTree.NewExpression): boolean {
  return call.type === 'CallExpression' && globalName(file, call.callee)?.startsWith('console.') === true;
}

const isFunctionNode = (node: AnyNode) => node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression' || node.type === 'FunctionDeclaration';
const isExpression = (node: AnyNode): node is ESTree.Expression => !/(Statement|Declaration)$/.test(node.type);

/** Compiles generated code for `filename`, registering its column map for stack traces. */
function compile(filename: string, { code, segments }: { code: string; segments: Map<number, Segment[]> }, params: string[], dependency: boolean): Function {
  try {
    // lineOffset -1 numbers the generated header line 0, so its frames never pose as an editor line.
    const factory = vm.compileFunction(code, params, { filename, lineOffset: -1, importModuleDynamically: importDynamically });
    sourceMaps.set(filename, segments);
    return factory;
  } catch (error) {
    if (!dependency) throw error;
    throw new LoaderError(`Cannot load declarations from ${path.basename(filename)}: ${(error as Error).message}`);
  }
}

/**
 * One file as a function: needed declarations and approved replays in source order, each at
 * its editor line and column where possible (the Builder maps the rest), so stack traces
 * point at real positions and TDZ errors match what the module itself would throw.
 *
 * A dependency returns accessors to its bindings; the root returns the selection's function.
 */
function compileFile(file: ModuleFile | undefined, source: string, selection?: SelectionPiece): { code: string; segments: Map<number, Segment[]> } {
  const position = lineIndex(source);
  const env = unique(source, '__jsRunnerEnv'), value = unique(source, '__jsRunnerValue'), run = unique(source, '__jsRunnerSelection');
  let header = 'with (__jsRunnerImports) return function () {"use strict";';
  if (selection) header += ` const ${run} = [];`;
  if (!selection && file) {
    // Accessors, not values, defined before the declarations (arrow functions only read the
    // bindings when called), on line 0, so a TDZ error from a getter never names a real line.
    // `const`, imports, and default exports get a throwing setter.
    const accessors = [...file.needed].map(name => {
      const declaration = file.declarations.get(name);
      const assignable = !file.origins.has(name) && (declaration?.kind === 'function' || (declaration?.kind === 'variable' && declaration.keyword !== 'const'));
      const setter = assignable ? `${value} => { ${name} = ${value}; }` : '() => { throw new TypeError("Assignment to constant variable."); }';
      return `${JSON.stringify(name)}: { get: () => ${name}, set: ${setter}, enumerable: true }`;
    });
    header += ` const ${env} = Object.create(null, { ${accessors.join(', ')} });`;
  }
  const builder = new Builder(header);
  const pieces: { start: number; emit: () => void }[] = [];
  const emit = (from: number, to: number, edits: Edit[], prefix: string, suffix: string) => {
    builder.moveTo(position(from), prefix.length);
    builder.generated(prefix);
    let cursor = from;
    for (const edit of edits) {
      builder.original(source.slice(cursor, edit.from), position(cursor));
      builder.generated(edit.text);
      cursor = edit.to;
    }
    builder.original(source.slice(cursor, to), position(cursor));
    builder.generated(suffix);
  };
  if (file) {
    const declarations = new Set([...file.needed].filter(name => !file.origins.has(name)).map(name => file.declarations.get(name)!));
    for (const declaration of declarations) {
      const node = declaration.node;
      const [prefix, suffix] = declaration.kind === 'variable' ? [`${declaration.keyword} `, ';']
        : declaration.kind === 'default' ? [`const ${declaration.local} = (`, ');']
        : ['', ''];
      pieces.push({ start: startOf(node), emit: () => emit(startOf(node), endOf(node), callEdits(file, node), prefix, suffix) });
    }
    for (const statement of file.approved) {
      pieces.push({ start: startOf(statement), emit: () => emit(startOf(statement), endOf(statement), callEdits(file, statement), '', source[endOf(statement) - 1] === ';' ? '' : ';') });
    }
  }
  if (selection) {
    // A shadowed name is declared at the end, so it stays in its TDZ for the whole selection:
    // using it throws instead of silently reaching the module binding of the same name.
    const tail = `${selection.close}${selection.shadowed.length ? `let ${selection.shadowed.join(', ')}; ` : ''}});`;
    // Passed as an argument, the one place V8 infers no name from, so the selection's frames
    // read `at main.js:3:5` like top-level code, not `at __jsRunnerSelection (…)`.
    pieces.push({ start: selection.start, emit: () => emit(selection.start, selection.end, selection.edits, `${run}.push(async function () {${selection.prelude}`, tail) });
  }
  pieces.sort((a, b) => a.start - b.start).forEach(piece => piece.emit());
  builder.generated(selection ? `\nreturn ${run}[0];\n};` : `\nreturn ${env};\n};`);
  return { code: builder.text, segments: builder.segments };
}

/**
 * `f(…)` → `(0, f)(…)` for calls to import bindings: a function found through a `with` scope
 * would otherwise be called with that scope object as `this`.
 */
export function callEdit(identifier: ESTree.Identifier, parent: ESTree.Node | undefined): Edit[] {
  const callee = (parent?.type === 'CallExpression' && parent.callee === identifier) || (parent?.type === 'TaggedTemplateExpression' && parent.tag === identifier);
  return callee ? [{ from: startOf(identifier), to: startOf(identifier), text: '(0, ', rank: 2 }, { from: endOf(identifier), to: endOf(identifier), text: ')', rank: 0 }] : [];
}

function callEdits(file: ModuleFile, node: AnyNode): Edit[] {
  return referencesWithin(file, node).flatMap(reference => {
    const variable = file.variables.get(reference.identifier.name);
    if (!variable || reference.resolved !== variable || !file.imports.has(variable.name)) return [];
    const identifier = reference.identifier as ESTree.Identifier;
    return callEdit(identifier, file.parents.get(identifier));
  });
}

const isGlobal = (file: ModuleFile, name: string) => !file.variables.has(name);

/** Returns why evaluating `node` could run user code or write state, or null when it provably can't. */
function unsafe(file: ModuleFile, node: AnyNode | null | undefined): string | null {
  if (!node) return null;
  switch (node.type) {
    case 'Literal': case 'Identifier': case 'FunctionExpression': case 'ArrowFunctionExpression': case 'FunctionDeclaration':
      return null;
    case 'TemplateLiteral':
      // Interpolation coerces with toString; primitives have no user toString.
      return node.expressions.every(expression => primitive(file, expression)) ? null : 'computed template';
    case 'ArrayExpression':
      for (const element of node.elements) {
        if (element?.type === 'SpreadElement') {
          // Spreading calls [Symbol.iterator], which an object literal can define.
          if (!builtinIterable(file, element.argument)) return 'spread of an iterable that may run user code';
          const reason = unsafe(file, element.argument);
          if (reason) return reason;
          continue;
        }
        const reason = unsafe(file, element);
        if (reason) return reason;
      }
      return null;
    case 'ObjectExpression':
      for (const property of node.properties) {
        if (property.type === 'SpreadElement') {
          // Object spread copies own data properties; validated objects have no getters.
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
    // Writes are only ever replayed as whole statements (see replayTarget), never inside an initializer.
    case 'AssignmentExpression':
      return 'assignment';
    case 'UpdateExpression':
      return 'update expression';
    case 'NewExpression': {
      const callee = globalName(file, node.callee);
      if ((callee === 'Map' || callee === 'Set') && node.arguments.length <= 1) {
        const [source] = node.arguments;
        if (!source) return null;
        // The constructor iterates its argument.
        if (source.type === 'SpreadElement' || !builtinIterable(file, source)) return 'Map or Set from an iterable that may run user code';
        return unsafe(file, source);
      }
      return 'NewExpression';
    }
    default:
      return node.type;
  }
}

/**
 * True when coercing `node`'s value to a primitive can't invoke user code: it's already a
 * primitive, a const initialized to one, or it's reached from an unshadowed global
 * (`Math.PI`). No user code has run when the loader evaluates, so globals are still built-in.
 */
function primitive(file: ModuleFile, node: ESTree.Node, seen = new Set<string>()): boolean {
  if (pristine(file, node)) return true;
  switch (node.type) {
    case 'Literal': return true;
    case 'Identifier': {
      // `const WEEK = DAY * 7`: a const can't be reassigned, so a primitive initializer stays primitive.
      const declaration = file.declarations.get(node.name);
      if (declaration?.kind !== 'variable' || declaration.keyword !== 'const' || !declaration.node.init || seen.has(node.name)) return false;
      seen.add(node.name);
      const result = primitive(file, declaration.node.init, seen);
      seen.delete(node.name);
      return result;
    }
    case 'TemplateLiteral': return node.expressions.every(expression => primitive(file, expression, seen));
    case 'UnaryExpression':
      if (node.operator === 'delete') return false;
      if (node.operator === '!' || node.operator === 'typeof' || node.operator === 'void') return unsafe(file, node.argument) === null;
      return primitive(file, node.argument, seen);
    case 'BinaryExpression':
      if (node.left.type === 'PrivateIdentifier') return false;
      if (node.operator === '===' || node.operator === '!==') return unsafe(file, node.left) === null && unsafe(file, node.right) === null;
      return primitive(file, node.left, seen) && primitive(file, node.right, seen);
    case 'LogicalExpression': return primitive(file, node.left, seen) && primitive(file, node.right, seen);
    case 'ConditionalExpression': return unsafe(file, node.test) === null && primitive(file, node.consequent, seen) && primitive(file, node.alternate, seen);
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
