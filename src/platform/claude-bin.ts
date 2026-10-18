import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appRoot } from '../config/env.js';

/**
 * The Claude Code program the Agent SDK drives. A git checkout uses the copy npm put next to the SDK;
 * a release leaves that 250 MB copy out and uses the one from Anthropic's official installer
 * (claude.ai/install.ps1 or install.sh), which keeps itself up to date.
 * Returns undefined when none is found, so the SDK falls back to its own lookup.
 */
export function findClaude(): string | undefined {
  const win = process.platform === 'win32';
  const exe = win ? 'claude.exe' : 'claude';
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const candidates = [
    path.join(appRoot(), 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, exe),
    path.join(os.homedir(), '.local', 'bin', exe),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const r = spawnSync(win ? 'where' : 'which', ['claude'], { encoding: 'utf8', windowsHide: true });
  const found = r.status === 0 ? r.stdout.split(/\r?\n/)[0]?.trim() : '';
  // On Windows "where" can list an npm .cmd shim first; the SDK needs the real program.
  return found && (!win || /\.exe$/i.test(found)) ? found : undefined;
}
