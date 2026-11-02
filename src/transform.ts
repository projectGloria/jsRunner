import { positionAt } from './scope';
import { analyzeSelection, type SelectionContext } from './selection';

/** What the runner needs: the document and where the selection sits in it. */
export interface Prepared { document: string; context: SelectionContext }

/**
 * Validates the selection here, so syntax errors need no process. Only the selection is
 * parsed on the extension host; the runner analyzes the document, so a large file can't
 * stall the editor.
 */
export function transformSelection(document: string, start: number, end: number, label = 'This file'): Prepared {
  analyzeSelection(document.slice(start, end), positionAt(document, start));
  return { document, context: { start, end, label } };
}

/** Code run on its own, as a whole document. */
export function transform(code: string): Prepared {
  return transformSelection(code, 0, code.length, 'The snippet');
}
