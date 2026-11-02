import { parse, type Comment } from 'acorn';
import { analyze, type Reference, type Scope, type ScopeManager } from 'eslint-scope';
import type * as ESTree from 'estree';

export type { ESTree, Reference, Scope, ScopeManager };

// `ranges: true` adds the standard ESTree `range` tuple, which is what eslint-scope's
// types expect. Acorn's own `start`/`end` exist too, but aren't part of ESTree.
export function parseModule(source: string, comments?: Comment[]): ESTree.Program {
  return parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true, allowHashBang: true, ranges: true, onComment: comments }) as unknown as ESTree.Program;
}

export function scopeOf(ast: ESTree.Program): ScopeManager {
  return analyze(ast, { ecmaVersion: 2022, sourceType: 'module', optimistic: true });
}

export function inspectScope(source: string) {
  const ast = parseModule(source);
  return { ast, scope: scopeOf(ast) };
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

/** positionAt for many lookups: binary search over line starts instead of rescanning the text. */
export function lineIndex(source: string): (offset: number) => { line: number; column: number } {
  const starts = [0];
  for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) starts.push(index + 1);
  return offset => {
    let low = 0, high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid; else high = mid - 1;
    }
    return { line: low + 1, column: offset - starts[low] };
  };
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

const isNode = (value: unknown): value is ESTree.Node =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';

/** Depth-first visit of every ESTree node under `root`, with its parent. */
export function walk(root: ESTree.Node, visit: (node: ESTree.Node, parent: ESTree.Node | undefined) => void) {
  const stack: [ESTree.Node, ESTree.Node | undefined][] = [[root, undefined]];
  while (stack.length) {
    const [node, parent] = stack.pop()!;
    visit(node, parent);
    // Generic over child keys, so new syntax can't silently hide a subtree. `range` and
    // positions hold numbers, which isNode skips.
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) { for (const item of value) if (isNode(item)) stack.push([item, node]); }
      else if (isNode(value)) stack.push([value, node]);
    }
  }
}

/** Parent links for a whole tree: eslint-scope references point at AST identifiers, not their context. */
export function parentsOf(root: ESTree.Node): Map<ESTree.Node, ESTree.Node> {
  const parents = new Map<ESTree.Node, ESTree.Node>();
  walk(root, (node, parent) => { if (parent) parents.set(node, parent); });
  return parents;
}
