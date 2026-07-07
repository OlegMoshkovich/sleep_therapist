export interface ChunkOptions {
  /** Target chunk size in characters. */
  size?: number;
  /** Characters carried from the tail of one chunk into the next. */
  overlap?: number;
}

// Paragraph-aware chunker: pack paragraphs into ~size-char chunks with a small
// overlap, then hard-split any single oversized paragraph. Deliberately simple
// — good enough for the B1 first slice; a token-aware splitter can replace it.
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const size = options.size ?? 1000;
  const overlap = options.overlap ?? 150;

  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];

  const paragraphs = clean
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const packed: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    if (current && current.length + p.length + 2 > size) {
      packed.push(current);
      current = overlap > 0 ? `${current.slice(-overlap)}\n\n${p}` : p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) packed.push(current);

  const result: string[] = [];
  for (const chunk of packed) {
    if (chunk.length <= size * 1.5) {
      result.push(chunk);
      continue;
    }
    const step = Math.max(1, size - overlap);
    for (let i = 0; i < chunk.length; i += step) {
      result.push(chunk.slice(i, i + size));
    }
  }
  return result;
}
