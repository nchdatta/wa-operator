/**
 * Set keys in .env text, keeping comments, other lines and the file's line endings.
 * A commented-out "# KEY=" line is reused; a missing key is appended.
 */
export function setEnvText(src: string, values: Record<string, string>): string {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  for (const [k, v] of Object.entries(values)) {
    const re = new RegExp(`^#?[ \\t]*${k}=`);
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else {
      while (lines.length && lines.at(-1) === '') lines.pop();
      lines.push(`${k}=${v}`, '');
    }
  }
  return lines.join(eol);
}

/**
 * A WhatsApp number as digits with the country code. Bangladesh numbers typed the local way
 * (01712345678) get the 88 prefix; any other number starting with 0 is rejected.
 */
export function normalizeWaId(input: string): string | null {
  const d = input.replace(/\D/g, '');
  if (/^01\d{9}$/.test(d)) return `88${d}`;
  if (d.startsWith('0') || d.length < 7 || d.length > 15) return null;
  return d;
}
