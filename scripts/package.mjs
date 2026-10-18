#!/usr/bin/env node
/**
 * Build the release archive for the platform this runs on (CI runs it once per OS/CPU, because the
 * database and password libraries are native and must match):
 *   node scripts/package.mjs     →  release/wa-operator-<os>-<arch>.zip (Windows) or .tar.gz
 * The archive holds a private copy of this Node, the built app and its runtime libraries. Claude Code
 * is left out: the installer gets it from Anthropic's official installer instead.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const win = process.platform === 'win32';
const target = `${win ? 'win' : process.platform}-${process.arch}`;
const out = path.join(root, 'release');
const stage = path.join(out, 'wa-operator');
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: 'inherit' });

const major = Number(process.versions.node.split('.')[0]);
if (major < 24) throw new Error(`build with Node 24+ (this is ${process.version}); the archive ships this Node`);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

run('npm run build');
for (const p of ['dist', 'drizzle', 'config/flows', 'package.json', 'package-lock.json', '.env.example', 'LICENSE']) {
  const src = path.join(root, p);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(stage, p), { recursive: true });
}
fs.mkdirSync(path.join(stage, 'scripts'));
fs.copyFileSync(path.join(root, 'scripts', win ? 'install.ps1' : 'install.sh'), path.join(stage, 'scripts', win ? 'install.ps1' : 'install.sh'));

// Runtime libraries only; native ones download their prebuilt binary for this platform.
run('npm ci --omit=dev --no-audit --no-fund', stage);
const sdk = path.join(stage, 'node_modules', '@anthropic-ai');
for (const d of fs.readdirSync(sdk)) {
  if (/^claude-agent-sdk-/.test(d)) fs.rmSync(path.join(sdk, d), { recursive: true, force: true });
}

// The SQLite library ships a binary for every platform plus its C sources: keep only this platform's.
const sqlite = path.join(stage, 'node_modules', 'better-sqlite3');
const plat = `${process.platform}-${process.arch}`;
for (const d of ['deps', 'src', path.join('build', 'Release', 'obj')]) fs.rmSync(path.join(sqlite, d), { recursive: true, force: true });
// Linux keeps the glibc and musl builds of its CPU; the library picks one at run time.
const keep = new Set([`${plat}.node`, ...(process.platform === 'linux' ? [`linuxmusl-${process.arch}.node`] : [])]);
for (const f of fs.readdirSync(path.join(sqlite, 'prebuilds')))
  if (!keep.has(f)) fs.rmSync(path.join(sqlite, 'prebuilds', f));

fs.copyFileSync(process.execPath, path.join(stage, win ? 'node.exe' : 'node'));
if (win) {
  fs.writeFileSync(path.join(stage, 'wa-operator.cmd'), '@"%~dp0node.exe" "%~dp0dist\\bin\\cli.js" %*\r\n');
} else {
  const shim = path.join(stage, 'wa-operator');
  fs.writeFileSync(
    shim,
    [
      '#!/bin/sh',
      '# Follow the ~/.local/bin link back to the app folder (no readlink -f on older macOS).',
      'f="$0"',
      'while [ -L "$f" ]; do l="$(readlink "$f")"; case "$l" in /*) f="$l" ;; *) f="$(dirname "$f")/$l" ;; esac; done',
      'D="$(cd "$(dirname "$f")" && pwd)"',
      'exec "$D/node" "$D/dist/bin/cli.js" "$@"',
      '',
    ].join('\n'),
  );
  fs.chmodSync(shim, 0o755);
}

const archive = path.join(out, `wa-operator-${target}${win ? '.zip' : '.tar.gz'}`);
// Windows 10+ ships bsdtar, which writes zip files and, unlike Compress-Archive, keeps .env.example.
if (win) run(`"%SystemRoot%\\System32\\tar.exe" -a -cf "${archive}" -C "${out}" wa-operator`);
else run(`tar -czf "${archive}" -C "${out}" wa-operator`);
console.log(`\n${archive} (${(fs.statSync(archive).size / 1e6).toFixed(0)} MB)`);
