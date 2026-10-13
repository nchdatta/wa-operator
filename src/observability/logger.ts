import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';
import { REDACT_PATHS } from '../security/redact.js';

export type { Logger };

export interface LoggerOptions {
  level: string;
  file?: string | undefined;
  /** Process name, e.g. "wa-operator". */
  name: string;
}

/**
 * Structured logger. Writes to **stderr** (fd 2) and optionally a file.
 */
export function createLogger(opts: LoggerOptions): Logger {
  const streams: pino.StreamEntry[] = [{ level: opts.level as pino.Level, stream: pino.destination(2) }];
  if (opts.file) {
    try {
      fs.mkdirSync(path.dirname(opts.file), { recursive: true });
      const dest = pino.destination({ dest: opts.file, mkdir: true });
      // A broken log file must never take the process down; stderr logging continues.
      dest.on('error', (e: Error) => process.stderr.write(`log file error: ${e.message}\n`));
      streams.push({ level: opts.level as pino.Level, stream: dest });
    } catch (e) {
      process.stderr.write(`log file disabled: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  return pino(
    { name: opts.name, level: opts.level, redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
    pino.multistream(streams),
  );
}

export const silentLogger: Logger = pino({ level: 'silent' });
