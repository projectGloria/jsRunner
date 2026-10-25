import { parse } from 'acorn';
import { analyze, type Reference, type Scope, type ScopeManager } from 'eslint-scope';
import type * as ESTree from 'estree';

export type { ESTree, Reference, Scope, ScopeManager };

// `ranges: true` adds the standard ESTree `range` tuple, which is what eslint-scope's
// types expect. Acorn's own `start`/`end` exist too, but aren't part of ESTree.
export function parseModule(source: string): ESTree.Program {
  return parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true, allowHashBang: true, ranges: true }) as unknown as ESTree.Program;
}

export function inspectScope(source: string) {
  const ast = parseModule(source);
  const scope = analyze(ast, { ecmaVersion: 2022, sourceType: 'module', optimistic: true });
  return { ast, scope };
}

// Structural, so ESTree's `MaybeNamed*` default-export nodes are accepted too.
export const startOf = (node: { range?: [number, number] }) => node.range![0];
export const endOf = (node: { range?: [number, number] }) => node.range![1];

/** 1-based line and 0-based column of an offset, matching V8 stack trace conventions. */
export function positionAt(source: string, offset: number) {
  let line = 1, lineStart = 0;
  for (let index = source.indexOf('\n'); index !== -1 && index < offset; index = source.indexOf('\n', index + 1)) {
    line++; lineStart = index + 1;
  }
  return { line, column: offset - lineStart };
}

export function bindingNames(pattern: ESTree.Pattern | null | undefined): string[] {
  if (!pattern) return [];
  switch (pattern.type) {
    case 'Identifier': return [pattern.name];
    case 'RestElement': return bindingNames(pattern.argument);
    case 'AssignmentPattern': return bindingNames(pattern.left);
    case 'ArrayPattern': return pattern.elements.flatMap(bindingNames);
    case 'ObjectPattern': return pattern.properties.flatMap(p => bindingNames(p.type === 'RestElement' ? p.argument : p.value));
    default: return [];
  }
}

/** Import/export names may be string literals (`export { x as "a-b" }`). */
export const moduleExportName = (node: ESTree.Identifier | ESTree.Literal) => node.type === 'Identifier' ? node.name : String(node.value);
