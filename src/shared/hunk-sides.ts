/**
 * Project a hunk's lines onto the two files it describes.
 *
 * A diff line only exists on one side: a `del` line is in the old file, an
 * `add` line in the new one, context in both. Anything that reads a hunk as
 * *code* — a tokenizer, most obviously — has to be handed one side at a time,
 * because the two interleaved are not a program. A removed line opening a
 * string and the added line that replaces it would read as one string opened
 * twice, and everything after it would be coloured as string.
 *
 * Reading whole sides rather than single lines is also the only way a multi-line
 * construct comes out right: a `/** … *\/` block spanning eight lines is one
 * comment, and a tokenizer shown its lines separately calls seven of them code.
 *
 * This module is the index arithmetic for that and deliberately nothing else.
 * It knows no tokenizer and imports nothing but a type, so the mapping — the
 * part where an off-by-one silently paints the wrong colours on the wrong
 * lines — can be tested on its own.
 */
import type { DiffLine } from './types.js';

/**
 * Reads one side's text, returning one result per line of it.
 *
 * `null` means the side could not be read, and aborts the whole hunk rather
 * than yielding an array that does not line up.
 */
export type SideReader<T> = (code: string, lineCount: number) => T[] | null;

type Side = 'old' | 'new';

/** The line kind that, by definition, is not present on a given side. */
const ABSENT_FROM: Record<Side, DiffLine['kind']> = { old: 'add', new: 'del' };

/**
 * Read a hunk's sides and fold the results back onto its lines.
 *
 * Returns one entry per element of `lines`, in the same order, or `null` if a
 * side came back the wrong length. Misaligned output is worse than none: it is
 * confident nonsense, and it looks like a bug in whatever consumed it rather
 * than one here.
 */
export function mapHunkSides<T>(lines: DiffLine[], read: SideReader<T>): (T | null)[] | null {
  const changed: Record<Side, boolean> = {
    old: lines.some((l) => l.kind === 'del'),
    new: lines.some((l) => l.kind === 'add'),
  };

  // A hunk that changes only one side needs only that side read: every line it
  // has is on that side. Pure additions are the common case, so this halves the
  // usual work rather than being a micro-optimisation.
  const sides: Side[] =
    changed.old && changed.new ? ['old', 'new'] : changed.old ? ['old'] : ['new'];

  const result: Partial<Record<Side, T[]>> = {};
  /** line index → its position within that side, or -1 when it is not on it. */
  const position: Partial<Record<Side, number[]>> = {};

  for (const side of sides) {
    const absent = ABSENT_FROM[side];
    const text: string[] = [];
    const index = new Array<number>(lines.length).fill(-1);
    lines.forEach((line, i) => {
      if (line.kind === absent) return;
      index[i] = text.length;
      text.push(line.text);
    });

    // No trailing newline: a reader is expected to return exactly one result
    // per line, and a trailing `\n` would add an empty one.
    const out = read(text.join('\n'), text.length);
    if (!out || out.length !== text.length) return null;
    result[side] = out;
    position[side] = index;
  }

  // When only one side was read it is the one every line is on, so a line
  // asking for the other still resolves here rather than falling through.
  const only = sides[0];
  return lines.map((line, i) => {
    const wanted: Side = line.kind === 'del' ? 'old' : 'new';
    const side = sides.includes(wanted) ? wanted : only;
    const at = position[side]![i];
    return at === -1 ? null : result[side]![at];
  });
}
