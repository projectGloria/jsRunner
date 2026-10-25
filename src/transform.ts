import { bindingNames, endOf, inspectScope, moduleExportName, parseModule, positionAt, startOf, type ESTree } from './scope';

/**
 * Code for the runner's async wrapper. Line 1 is a generated header; the selection
 * starts on line 2. `lineOffset` maps line 2 back to the editor line, so stack traces
 * name real editor positions.
 */
export interface Transformed { code: string; lineOffset: number; notice?: string }

function parseJavaScript(code: string): ESTree.Program {
  try {
    return parseModule(code);
  } catch (error) {
    throw new Error(`Invalid JavaScript: ${(error as Error).message}. TypeScript and JSX are not supported.`);
  }
}

/** Runs the selection with the module-level bindings it references from the rest of the document. */
export function transformSelection(document: string, start: number, end: number, label = 'This file'): Transformed {
  const selection = document.slice(start, end);
  // Validate the selection first: its own errors are the most relevant ones.
  const { header, body } = transformCode(selection);
  const position = positionAt(document, start);
  let context = '', notice: string | undefined;
  try {
    const names = contextNames(document, start, selection);
    // `let`, so the selection can reassign them locally. `arguments[0]` is the runner's
    // loader: unlike any parameter name, it can't collide with user identifiers.
    if (names.length) context = `let { ${names.join(', ')} } = await arguments[0](${JSON.stringify(names)});`;
  } catch (error) {
    // The selection is valid on its own. Run it rather than blocking on unrelated code
    // (half-typed lines elsewhere, JS inside Markdown/HTML, TypeScript files).
    if (freeNames(selection).length) {
      notice = `Note: ${label} isn't valid JavaScript as a whole (${(error as Error).message}), so only the selection ran. Imports and declarations outside it weren't loaded.`;
    }
  }
  return {
    // Pad the first selected line to its editor column so columns match too.
    code: `${context} ${header}\n${' '.repeat(position.column)}${body}`,
    lineOffset: position.line - 2,
    notice,
  };
}

/** Selection run on its own, with no document context. */
export function transform(code: string): Transformed {
  const { header, body } = transformCode(code);
  return { code: `${header}\n${body}`, lineOffset: -1 };
}

/** Free names of the selection that the document binds at module level, at those exact positions. */
function contextNames(document: string, start: number, selection: string): string[] {
  const { scope } = inspectScope(document);
  const moduleScope = scope.scopes.find(s => s.type === 'module')!;
  const documentReferences = new Map(scope.scopes.flatMap(s => s.references).map(r => [startOf(r.identifier as ESTree.Identifier), r]));
  const names = new Set<string>();
  for (const reference of inspectScope(selection).scope.globalScope!.through) {
    // Resolve each free identifier where it sits in the document. A selection inside a
    // function body sees that function's parameters, not same-named module bindings.
    const resolved = documentReferences.get(start + startOf(reference.identifier as ESTree.Identifier))?.resolved;
    if (resolved && resolved.scope === moduleScope) names.add(resolved.name);
  }
  return [...names];
}

function freeNames(selection: string): string[] {
  return inspectScope(selection).scope.globalScope!.through.map(r => r.identifier.name).filter(name => !(name in globalThis));
}

function transformCode(code: string): { header: string; body: string } {
  const ast = parseJavaScript(code);
  if (ast.body.some(n => n.type.startsWith('Export'))) {
    throw new Error('Export statements cannot run as a selection. Select executable code without export statements. Imported modules may use exports normally.');
  }
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
  });
  // Blank import declarations without changing the AST offsets used below.
  for (const declaration of [...imports].reverse()) {
    code = code.slice(0, startOf(declaration)) + code.slice(startOf(declaration), endOf(declaration)).replace(/[^\r\n]/g, ' ') + code.slice(endOf(declaration));
  }
  // The prelude shares the header line, so it never shifts the selection's line numbers.
  const header = prelude.join(' ');
  const last = ast.body.filter(n => n.type !== 'ImportDeclaration').at(-1);
  if (last?.type === 'ExpressionStatement') {
    // `return (` sits on the expression's own line; only that line's columns shift.
    return { header, body: code.slice(0, startOf(last)) + 'return (' + code.slice(startOf(last.expression), endOf(last.expression)) + '\n);' + code.slice(endOf(last)) };
  }
  if (last?.type === 'VariableDeclaration') {
    const bindings = last.declarations.flatMap(d => bindingNames(d.id));
    return { header, body: code + '\n;return {' + bindings.map(n => `[${JSON.stringify(n)}]: ${n}`).join(',') + '};' };
  }
  // A trailing function or class declaration displays the declared value, like a trailing const.
  if ((last?.type === 'FunctionDeclaration' || last?.type === 'ClassDeclaration') && last.id) {
    return { header, body: code + `\n;return ${last.id.name};` };
  }
  return { header, body: code };
}
