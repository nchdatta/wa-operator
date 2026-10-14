import path from 'node:path';

/** What `npm run uninstall -- --purge` deletes. .env is never on this list. */
export const PURGE_TARGETS = ['data', 'logs', 'dist', 'tools'] as const;

/** Refuse anything that is, or contains, the .env file. */
export function purgePaths(root: string): string[] {
  return PURGE_TARGETS.map((p) => path.join(root, p)).filter((p) => !/(^|[/\\])\.env/i.test(path.relative(root, p)));
}
