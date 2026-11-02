export type Position = { line: number; column: number };

/** From generated column `gen` on, a generated line continues the editor text at `line`/`column`. */
export interface Segment { gen: number; line: number; column: number }

/**
 * Column maps of every file compiled in this run, keyed by filename and by line as V8 reports
 * it. The runner maps stack frames through them back to editor positions.
 */
export const sourceMaps = new Map<string, Map<number, Segment[]>>();

/**
 * Builds compiled code that keeps original text at its editor line and column where it can,
 * and records where it can't (generated text earlier on the line, a statement placed out of
 * order), so stack traces still name editor positions. Lines are numbered as V8 reports them
 * under `lineOffset: -1`: the generated header is line 0, which no editor line can be.
 */
export class Builder {
  private parts: string[] = [];
  private line = 0;
  private column = 0;
  readonly segments = new Map<number, Segment[]>();

  constructor(header: string) { this.write(header); }

  get text() { return this.parts.join(''); }

  /** Generated code: nothing in it maps back to the editor. */
  generated(text: string) { this.write(text); }

  /**
   * Moves to editor `position`, minus room for `prefix` columns of generated code, so the
   * original text that follows lands on its own line and column whenever it still can.
   */
  moveTo(position: Position, prefix = 0) {
    if (position.line > this.line) this.write('\n'.repeat(position.line - this.line));
    const column = position.column - prefix;
    if (position.line === this.line && this.column <= column) this.write(' '.repeat(column - this.column));
    else if (this.column > 0) this.write(' ');
  }

  /** Original text whose first character is at editor `position`. */
  original(text: string, position: Position) {
    if (!text) return;
    const lines = text.split('\n');
    this.mark(this.line, this.column, position);
    for (let k = 1; k < lines.length; k++) this.mark(this.line + k, 0, { line: position.line + k, column: 0 });
    this.write(text);
  }

  private mark(line: number, gen: number, position: Position) {
    let list = this.segments.get(line);
    if (!list) this.segments.set(line, list = []);
    list.push({ gen, line: position.line, column: position.column });
  }

  private write(text: string) {
    this.parts.push(text);
    const lastBreak = text.lastIndexOf('\n');
    if (lastBreak === -1) { this.column += text.length; return; }
    for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) this.line++;
    this.column = text.length - lastBreak - 1;
  }
}

/**
 * The editor position of a V8 frame position (1-based column) in a compiled file, or null for
 * generated-only code (line 0). Files this run didn't compile keep their position.
 */
export function mapPosition(filename: string, line: number, column: number): Position | null {
  const map = sourceMaps.get(filename);
  if (!map) return { line, column };
  if (line === 0) return null;
  const segments = map.get(line);
  if (!segments?.length) return { line, column };
  // Generated text before the line's first original text (the selection's opening and its
  // own imports) is attributed to where that original text starts.
  let found = segments[0];
  for (const segment of segments) if (segment.gen <= column - 1) found = segment; else break;
  return { line: found.line, column: found.column + Math.max(0, column - 1 - found.gen) + 1 };
}
