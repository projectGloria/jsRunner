import type { Comment } from 'acorn';
import { parseModule, walk, type ESTree } from './scope';
import type { Position } from './builder';

/** Where the selection sits in the document it was taken from. */
export interface SelectionContext { start: number; end: number; label: string }

/**
 * Parses and validates a selection as it will run. Shared by the extension host (instant
 * feedback, no process spawned) and the runner (which compiles it). `origin` is the editor
 * position of the selection's first character, for error messages.
 */
export function analyzeSelection(code: string, origin: Position): { ast: ESTree.Program; comments: Comment[] } {
  const comments: Comment[] = [];
  let ast: ESTree.Program;
  try {
    ast = parseModule(code, comments);
  } catch (error) {
    const { message, loc } = error as SyntaxError & { loc?: Position };
    const reason = message.replace(/\s*\(\d+:\d+\)$/, '');
    // Acorn positions are relative to the selection; report editor positions.
    const where = loc ? ` at line ${origin.line + loc.line - 1}, column ${(loc.line === 1 ? origin.column : 0) + loc.column + 1}` : '';
    const hint = /'return' outside of function/.test(reason)
      ? 'A selection runs as top-level code: select the returned expression instead of the return statement.'
      : 'Select complete JavaScript statements or expressions. TypeScript, JSX, and sloppy-mode-only syntax are not supported.';
    throw new Error(`Invalid JavaScript${where}: ${reason}. ${hint}`);
  }
  if (ast.body.some(n => n.type.startsWith('Export'))) {
    throw new Error('Export statements cannot run as a selection. Select executable code without export statements. Imported modules may use exports normally.');
  }
  walk(ast, node => {
    // Valid in the module grammar used to parse, but a SyntaxError in the function it runs in.
    if (node.type === 'MetaProperty' && node.meta.name === 'import') {
      throw new Error('import.meta is unavailable: a selection runs inside a function, not as an ES module. Use __filename and __dirname instead.');
    }
  });
  return { ast, comments };
}
