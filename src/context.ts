import type { Comment } from 'acorn';
import { bindingNames, endOf, inspectScope, moduleExportName, parentsOf, parseModule, positionAt, scopeOf, startOf, type ESTree, type Reference } from './scope';
import { callEdit, Loader, type Edit, type SelectionPiece } from './declarations';
import { analyzeSelection, type SelectionContext } from './selection';

// The runner passes these to the selection as parameters, so they're never document names.
const PROVIDED = new Set(['require', 'module', 'exports', '__filename', '__dirname']);

/** Text inserted before the final expression, so the selection returns its value. */
const RESULT_PREFIX = 'return [(';

/**
 * Compiles the selection with what it references from the document. Runs in the runner
 * process, never the extension host: parsing a large document here can't freeze the editor,
 * and `globalThis` is the snippet's real runtime.
 */
export async function prepare(document: string, filename: string, { start, end, label }: SelectionContext): Promise<{ snippet: () => Promise<unknown[] | undefined>; notes: string[] }> {
  const code = document.slice(start, end);
  const { ast, comments } = analyzeSelection(code, positionAt(document, start));
  const free = scopeOf(ast).globalScope!.through;
  const notes: string[] = [];
  // Selection references that the document binds at module level, at those exact positions.
  let fromModule = new Set<Reference>();
  if (free.length) {
    try {
      fromModule = moduleReferences(document, start, free);
    } catch (error) {
      // The selection is valid on its own. Run it rather than blocking on unrelated code
      // (half-typed lines elsewhere, JS inside Markdown/HTML, TypeScript files). Only worth a
      // note when something the selection uses could have come from the file.
      if (free.some(r => !PROVIDED.has(r.identifier.name) && !(r.identifier.name in globalThis))) {
        // Acorn's `(3:18)` is a 0-based column; say it the way the editor does.
        const { message, loc } = error as SyntaxError & { loc?: { line: number; column: number } };
        const reason = loc ? `${message.replace(/\s*\(\d+:\d+\)$/, '')} at line ${loc.line}, column ${loc.column + 1}` : message;
        notes.push(`Note: ${label} isn't valid JavaScript as a whole (${reason}), so only the selection ran. Imports and declarations outside it weren't loaded.`);
      }
    }
  }
  const names = [...new Set([...fromModule].map(r => r.identifier.name))];
  const loader = new Loader();
  const root = names.length ? loader.file(filename, document) : undefined;
  if (root) {
    root.cutoff = start;
    for (const name of names) loader.need(root, name);
  }
  // The selection is compiled inside the root's function, where every loaded module binding is
  // in scope. A free name the document resolves elsewhere (a parameter of the function the
  // selection was taken from) must not silently reach a module binding of the same name.
  const shadowed = root ? [...new Set(free.filter(r => !fromModule.has(r) && root.needed.has(r.identifier.name)).map(r => r.identifier.name))] : [];
  const parents = parentsOf(ast);
  const importCalls = [...fromModule].filter(r => root?.imports.has(r.identifier.name)).flatMap(r => callEdit(r.identifier as ESTree.Identifier, parents.get(r.identifier as ESTree.Identifier)));
  const piece = selectionPiece(code, ast, comments, importCalls, shadowed);
  // Selection offsets → document offsets.
  piece.edits = piece.edits.map(edit => ({ ...edit, from: edit.from + start, to: edit.to + start }));
  const snippet = await loader.compileRoot(root, document, filename, { ...piece, start, end });
  return { snippet, notes: [...notes, ...loader.notes()] };
}

/** Selection references that resolve, where they sit in the document, to its module scope. */
function moduleReferences(document: string, start: number, free: Reference[]): Set<Reference> {
  const { scope } = inspectScope(document);
  const moduleScope = scope.scopes.find(s => s.type === 'module')!;
  const documentReferences = new Map(scope.scopes.flatMap(s => s.references).map(r => [startOf(r.identifier as ESTree.Identifier), r]));
  // A selection inside a function body sees that function's parameters, not same-named module bindings.
  return new Set(free.filter(reference => documentReferences.get(start + startOf(reference.identifier as ESTree.Identifier))?.resolved?.scope === moduleScope));
}

/** Edits that turn the selection into the body of an async function returning `[value]`. */
function selectionPiece(code: string, ast: ESTree.Program, comments: Comment[], importCalls: Edit[], shadowed: string[]): Omit<SelectionPiece, 'start' | 'end'> {
  // A line comment running to the selection's end would swallow anything appended on that line.
  const close = comments.some(c => c.type === 'Line' && !code.slice(c.end).includes('\n')) ? '\n' : ' ';
  const edits: Edit[] = [...importCalls];
  // `#!` is only valid at the very start of a script; inside the function it's a comment.
  if (code.startsWith('#!')) edits.push({ from: 0, to: 2, text: '//', rank: 0 });

  const imports = ast.body.filter((n): n is ESTree.ImportDeclaration => n.type === 'ImportDeclaration');
  const prelude: string[] = [];
  imports.forEach((declaration, index) => {
    let temp = `__jsRunnerImport${index}`;
    while (code.includes(temp)) temp += '_';
    const source = JSON.stringify(declaration.source.value);
    const attributes = declaration.attributes?.length
      ? `, { with: ${JSON.stringify(Object.fromEntries(declaration.attributes.map(a => [moduleExportName(a.key), a.value.value])))} }` : '';
    prelude.push(`const ${temp} = await import(${source}${attributes});`);
    for (const spec of declaration.specifiers) {
      if (spec.type === 'ImportNamespaceSpecifier') {
        prelude.push(`const ${spec.local.name} = ${temp};`);
      } else {
        const key = spec.type === 'ImportDefaultSpecifier' ? 'default' : moduleExportName(spec.imported);
        prelude.push(`if (!(${JSON.stringify(key)} in ${temp})) throw new Error(${JSON.stringify(`Module ${declaration.source.value} does not export '${key}'.`)});`);
        prelude.push(`const ${spec.local.name} = ${temp}[${JSON.stringify(key)}];`);
      }
    }
    // Blanked in place, keeping line breaks, so everything after keeps its position.
    edits.push({ from: startOf(declaration), to: endOf(declaration), text: code.slice(startOf(declaration), endOf(declaration)).replace(/[^\r\n]/g, ' '), rank: 0 });
  });

  const statements = ast.body.filter(n => n.type !== 'ImportDeclaration');
  const last = statements.at(-1);
  // Every value is returned inside an array, so the runner can tell "no value" from
  // `undefined`, and await only real promises (a bare `return thenable` would adopt it).
  const value: [number, number] | undefined =
    last?.type === 'ExpressionStatement' ? [startOf(last.expression), endOf(last.expression)]
    // Like the Node.js REPL: `{ a: 1 }` alone parses as a block with a label, but means an object.
    : last?.type === 'BlockStatement' && statements.length === 1 && isObjectLiteral(code.slice(startOf(last), endOf(last))) ? [startOf(last), endOf(last)]
    : undefined;
  if (last && value) {
    // A parenthesized statement's own parentheses are replaced along with any semicolon.
    edits.push({ from: startOf(last), to: value[0], text: RESULT_PREFIX, rank: 1 }, { from: value[1], to: endOf(last), text: ')];', rank: 1 });
  } else if (last?.type === 'VariableDeclaration') {
    // A trailing declaration displays its bindings.
    const bindings = last.declarations.flatMap(d => bindingNames(d.id));
    edits.push({ from: code.length, to: code.length, text: `${close};return [{${bindings.map(n => `[${JSON.stringify(n)}]: ${n}`).join(',')}}];`, rank: 1 });
  } else if ((last?.type === 'FunctionDeclaration' || last?.type === 'ClassDeclaration') && last.id) {
    // A trailing function or class declaration displays the declared value, like a trailing const.
    edits.push({ from: code.length, to: code.length, text: `${close};return [${last.id.name}];`, rank: 1 });
  }
  edits.sort((a, b) => a.from - b.from || a.rank - b.rank);
  return { edits, prelude: prelude.length ? ` ${prelude.join(' ')} ` : '', close, shadowed };
}

function isObjectLiteral(text: string): boolean {
  try {
    const [statement] = parseModule(`(${text})`).body;
    return statement?.type === 'ExpressionStatement' && statement.expression.type === 'ObjectExpression';
  } catch {
    return false;
  }
}
