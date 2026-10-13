/**
 * Split text into chunks of at most `max` characters, preferring paragraph, then line, then word
 * boundaries. A single word longer than `max` is the only thing ever cut mid-way.
 */
export function chunkText(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = -1;
    for (const sep of ['\n\n', '\n', ' ']) {
      const i = window.lastIndexOf(sep, max);
      if (i > max * 0.3) {
        cut = i;
        break;
      }
    }
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** Turn common Markdown into WhatsApp formatting: **bold** → *bold*, headings → bold lines, links → "text (url)". */
export function toChatFormat(md: string): string {
  return md
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 ($2)')
    .replace(/^```\w*\n?|```$/gm, '```');
}
