import { identifierTokens } from './reuse.js';

/**
 * Verbatim line extraction. Keeps only the lines of a long text that contain an identifier the
 * conversation cites later (plus a little context, the head and the tail) and replaces the rest
 * with an omission marker. Every kept line is word for word; nothing is rewritten.
 */
export interface ExtractOptions {
  /** Texts shorter than this are left alone. */
  minChars: number;
  /** Lines kept around each cited line. */
  context: number;
  /** Always keep this many lines from the start and from the end. */
  headLines: number;
  tailLines: number;
}

export const DEFAULT_EXTRACT: ExtractOptions = { minChars: 3000, context: 1, headLines: 4, tailLines: 2 };

/** Returns the extracted text, or the original when extraction would save little. */
export function extractCitedLines(
  text: string,
  cited: ReadonlySet<string>,
  options: ExtractOptions = DEFAULT_EXTRACT,
): string {
  if (text.length < options.minChars || cited.size === 0) return text;
  const lines = text.split(String.fromCharCode(10));
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < Math.min(options.headLines, lines.length); i++) keep[i] = true;
  for (let i = Math.max(0, lines.length - options.tailLines); i < lines.length; i++) keep[i] = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length < 6) continue;
    let hit = false;
    for (const token of identifierTokens(line)) {
      if (cited.has(token)) {
        hit = true;
        break;
      }
    }
    if (!hit) continue;
    for (let j = Math.max(0, i - options.context); j <= Math.min(lines.length - 1, i + options.context); j++) keep[j] = true;
  }
  const out: string[] = [];
  let omitted = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (omitted > 0) out.push(`[… ${omitted} lines omitted …]`);
      omitted = 0;
      out.push(lines[i]!);
    } else omitted++;
  }
  if (omitted > 0) out.push(`[… ${omitted} lines omitted …]`);
  const result = out.join(String.fromCharCode(10));
  return result.length >= text.length * 0.85 ? text : result;
}

/** Identifiers in `text` that also appear in `later`. */
export function citedIn(text: string, later: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const token of identifierTokens(text)) if (later.has(token)) out.add(token);
  return out;
}
