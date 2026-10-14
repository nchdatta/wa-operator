import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppContext } from '../context.js';
import type { Config } from '../config/env.js';

/**
 * Local speech-to-text for voice notes: a whisper.cpp server started and stopped with the service,
 * listening on 127.0.0.1 only. Audio never leaves the PC. `--convert` hands OGG/Opus to ffmpeg.
 */
export class WhisperManager {
  private proc: ChildProcess | null = null;
  private stopped = false;
  private failures = 0;

  constructor(
    private readonly config: Config,
    private readonly logger: AppContext['logger'],
  ) {}

  /** Whether this service should run whisper itself. */
  static wanted(c: Config): boolean {
    return !c.WHISPER_URL && !!c.WHISPER_BIN && !!c.WHISPER_MODEL;
  }

  get url(): string {
    return `http://127.0.0.1:${this.config.WHISPER_PORT}`;
  }

  start(): void {
    const c = this.config;
    if (!fs.existsSync(c.WHISPER_BIN!) || !fs.existsSync(c.WHISPER_MODEL!)) {
      this.logger.error(
        { bin: c.WHISPER_BIN, model: c.WHISPER_MODEL },
        'whisper not found; re-run: npm run setup -- --only voice',
      );
      return;
    }
    const env = { ...process.env };
    // After a winget/brew upgrade the saved path can be gone; PATH usually has ffmpeg then.
    if (c.FFMPEG_BIN && fs.existsSync(c.FFMPEG_BIN))
      env.PATH = `${path.dirname(c.FFMPEG_BIN)}${path.delimiter}${env.PATH ?? ''}`;
    const threads = String(Math.max(1, Math.min(8, os.cpus().length - 1)));
    // Its own temp folder: --convert writes the converted audio to the working directory.
    const cwd = path.join(os.tmpdir(), 'wa-operator-whisper');
    fs.mkdirSync(cwd, { recursive: true });
    const p = spawn(
      c.WHISPER_BIN!,
      [
        '-m',
        c.WHISPER_MODEL!,
        '--host',
        '127.0.0.1',
        '--port',
        String(c.WHISPER_PORT),
        '-l',
        c.WHISPER_LANG,
        '-t',
        threads,
        '--convert',
      ],
      { cwd, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    this.proc = p;
    let tail = '';
    p.stderr?.on('data', (d: Buffer) => (tail = (tail + d.toString()).slice(-500)));
    p.on('error', (e) => this.logger.error({ err: e.message }, 'whisper failed to start'));
    p.on('exit', (code) => {
      if (this.proc === p) this.proc = null;
      if (this.stopped) return;
      this.failures++;
      const wait = Math.min(300, 10 * 2 ** Math.min(this.failures, 5));
      this.logger.warn({ code, tail: tail.trim() }, `whisper exited; restarting in ${wait} s`);
      setTimeout(() => !this.stopped && this.start(), wait * 1000);
    });
    this.logger.info({ url: this.url, lang: c.WHISPER_LANG }, 'whisper starting');
    // A run that lasts a few minutes counts as healthy again.
    setTimeout(() => this.proc === p && (this.failures = 0), 300_000).unref();
  }

  stop(): void {
    this.stopped = true;
    this.proc?.kill();
  }
}
