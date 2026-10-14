import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

/**
 * Installs what voice notes need into <app>/tools/whisper:
 *   whisper-server  Windows / Linux: official whisper.cpp build (pinned); macOS: Homebrew
 *   model           ggml-<size>.bin from Hugging Face, checked against its SHA-256
 *   ffmpeg          winget / Homebrew; Linux: the system package
 */

/** whisper.cpp build with prebuilt binaries (released 2026-09-11). */
const RELEASE = 'b5130';
const RELEASE_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE}`;
const MODEL_URL = (size: string) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${size}.bin`;

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const EXE = WIN ? 'whisper-server.exe' : 'whisper-server';

export interface VoiceTools {
  bin: string;
  model: string;
  ffmpeg: string;
}

type Say = (s: string) => void;

function run(cmd: string, args: string[], quiet = false): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: WIN && !/\.exe$/i.test(cmd),
    stdio: quiet ? 'pipe' : 'inherit',
  });
  return { ok: !r.error && r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function which(cmd: string): string {
  const r = run(WIN ? 'where' : 'which', [cmd], true);
  return r.ok ? (r.out.split(/\r?\n/)[0]?.trim() ?? '') : '';
}

function find(dir: string, name: string): string {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = find(p, name);
      if (hit) return hit;
    } else if (e.name.toLowerCase() === name.toLowerCase()) return p;
  }
  return '';
}

/** Download to `file` with a progress line; optional SHA-256 check. */
async function download(url: string, file: string, say: Say, sha256?: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const hash = crypto.createHash('sha256');
  let got = 0;
  let shown = -1;
  const body = Readable.fromWeb(res.body as WebReadableStream);
  body.on('data', (c: Buffer) => {
    hash.update(c);
    got += c.length;
    const pct = total ? Math.floor((got / total) * 100) : -1;
    if (pct >= 0 && pct !== shown && pct % 5 === 0) {
      shown = pct;
      process.stdout.write(`\r  ${path.basename(file)}: ${pct}% of ${Math.round(total / 1e6)} MB   `);
    }
  });
  const part = `${file}.part`;
  await pipeline(body, fs.createWriteStream(part));
  process.stdout.write('\n');
  if (sha256 && hash.digest('hex') !== sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(`${path.basename(file)} failed its checksum; try again`);
  }
  fs.renameSync(part, file);
  say(`${path.basename(file)} downloaded`);
}

async function ffmpeg(say: Say): Promise<string> {
  let bin = which('ffmpeg');
  if (bin) return bin;
  if (WIN) {
    say('installing ffmpeg with winget…');
    run('winget', [
      'install',
      '-e',
      '--id',
      'Gyan.FFmpeg',
      '--accept-source-agreements',
      '--accept-package-agreements',
    ]);
    // winget does not update this process's PATH: look where it puts programs.
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    const links = path.join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe');
    const pkgs = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    bin = fs.existsSync(links) ? links : '';
    if (!bin && fs.existsSync(pkgs))
      for (const d of fs.readdirSync(pkgs).filter((d) => d.startsWith('Gyan.FFmpeg'))) {
        bin = find(path.join(pkgs, d), 'ffmpeg.exe');
        if (bin) break;
      }
  } else if (MAC && which('brew')) {
    say('installing ffmpeg with Homebrew…');
    run('brew', ['install', 'ffmpeg']);
    bin = which('ffmpeg');
  }
  if (!bin)
    throw new Error(
      MAC || WIN
        ? 'ffmpeg could not be installed; install it, then re-run: npm run setup -- --only voice'
        : 'ffmpeg is missing: sudo apt install ffmpeg (or your distribution’s package), then re-run: npm run setup -- --only voice',
    );
  return bin;
}

async function server(dir: string, say: Say): Promise<string> {
  if (MAC) {
    let bin = which('whisper-server');
    if (!bin) {
      if (!which('brew')) throw new Error('Homebrew is needed on macOS: https://brew.sh, then re-run this step');
      say('installing whisper-cpp with Homebrew…');
      run('brew', ['install', 'whisper-cpp']);
      bin = which('whisper-server');
    }
    if (!bin) throw new Error('whisper-server not found after brew install whisper-cpp');
    return bin;
  }
  const existing = fs.existsSync(dir) ? find(dir, EXE) : '';
  if (existing) return existing;
  const arch = os.arch();
  const asset = WIN
    ? arch === 'arm64'
      ? 'whisper-bin-win-cpu-arm64.zip'
      : 'whisper-bin-x64.zip'
    : arch === 'arm64'
      ? 'whisper-bin-ubuntu-arm64.tar.gz'
      : 'whisper-bin-ubuntu-x64.tar.gz';
  const archive = path.join(dir, asset);
  await download(`${RELEASE_URL}/${asset}`, archive, say);
  const r = WIN
    ? run(
        'powershell.exe',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dir}' -Force`],
        true,
      )
    : run('tar', ['-xzf', archive, '-C', dir], true);
  fs.rmSync(archive, { force: true });
  if (!r.ok) throw new Error(`could not unpack ${asset}: ${r.out.slice(0, 300)}`);
  const bin = find(dir, EXE);
  if (!bin) throw new Error(`${EXE} is not in ${asset}`);
  if (!WIN) fs.chmodSync(bin, 0o755);
  return bin;
}

async function model(dir: string, size: string, say: Say): Promise<string> {
  const file = path.join(dir, `ggml-${size}.bin`);
  if (fs.existsSync(file)) return file;
  // Hugging Face reports the file's SHA-256 in x-linked-etag.
  const head = await fetch(MODEL_URL(size), { method: 'HEAD', redirect: 'manual' });
  const sha = head.headers.get('x-linked-etag')?.replace(/"/g, '');
  await download(MODEL_URL(size), file, say, sha && /^[0-9a-f]{64}$/.test(sha) ? sha : undefined);
  return file;
}

export async function installVoice(root: string, size: string, say: Say): Promise<VoiceTools> {
  const dir = path.join(root, 'tools', 'whisper');
  fs.mkdirSync(dir, { recursive: true });
  const ff = await ffmpeg(say);
  say(`ffmpeg: ${ff}`);
  const bin = await server(dir, say);
  say(`whisper-server: ${bin}`);
  const m = await model(dir, size, say);
  say(`model: ${m}`);
  const check = run(bin, ['--help'], true);
  if (!/usage|--port/i.test(check.out)) throw new Error(`whisper-server does not run here: ${check.out.slice(0, 300)}`);
  return { bin, model: m, ffmpeg: ff };
}
