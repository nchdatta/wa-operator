#!/usr/bin/env node
/* eslint-disable no-console -- command-line tool */
/**
 * Day-to-day commands, the same on Windows, macOS and Linux:
 *   npm start      turn autostart on and start everything
 *   npm stop       stop everything (service, tunnel, leftovers) and turn autostart off
 *   npm run restart   build, stop, start
 *   npm run status    what is installed and running
 *   npm run logs      follow logs/operator.log
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { appRoot, envFilePath, hint, stateDir } from '../config/env.js';
import { autostartStatus, startAll, stopAll } from '../platform/autostart.js';

process.noDeprecation = true;

const ROOT = appRoot();
const env = (() => {
  const f = envFilePath();
  return fs.existsSync(f) ? parseDotenv(fs.readFileSync(f)) : {};
})();
const port = Number(env.WEBHOOK_PORT ?? 3100);

function stop(): void {
  const r = stopAll(ROOT, port);
  console.log(
    `stopped${r.units.length ? `: ${r.units.join(', ')}` : ''}; ended ${r.killed} leftover program(s). Autostart is off until ${hint('start')}.`,
  );
}

function start(): void {
  const list = startAll();
  console.log(`started: ${list.join(', ')}. Autostart at logon is on.`);
}

async function status(): Promise<void> {
  for (const u of autostartStatus(env.TUNNEL_MODE === 'named'))
    console.log(
      `${u.label}: ${!u.installed ? `not installed (${hint('setup --only autostart')})` : u.enabled ? 'autostart on' : `autostart off (${hint('start')})`}`,
    );
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(3000) });
    console.log(`running: ${res.ok ? 'yes' : `no (HTTP ${res.status})`}`);
  } catch {
    console.log('running: no');
  }
}

function logs(): void {
  const file = path.join(stateDir(), 'logs', 'operator.log');
  if (!fs.existsSync(file)) return void console.log(`no log yet at ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  process.stdout.write(`${text.split('\n').slice(-31).join('\n')}`);
  let pos = Buffer.byteLength(text);
  fs.watchFile(file, { interval: 500 }, (cur) => {
    if (cur.size < pos) pos = 0; // rotated
    if (cur.size === pos) return;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(cur.size - pos);
    fs.readSync(fd, buf, 0, buf.length, pos);
    fs.closeSync(fd);
    pos = cur.size;
    process.stdout.write(buf);
  });
}

const cmd = process.argv[2];
try {
  if (cmd === 'stop') stop();
  else if (cmd === 'start') start();
  else if (cmd === 'restart') {
    stop();
    await new Promise((r) => setTimeout(r, 2000));
    start();
  } else if (cmd === 'status') await status();
  else if (cmd === 'logs') logs();
  else {
    console.log('Usage: control start|stop|restart|status|logs');
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
