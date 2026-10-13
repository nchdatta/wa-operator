import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Button, Channel, ListRow } from '../src/channels/channel.js';
import { buildConfig, type Config } from '../src/config/env.js';
import type { AppContext } from '../src/context.js';
import { silentLogger } from '../src/observability/logger.js';
import { openDb } from '../src/persistence/db.js';
import { FakeClock } from '../src/shared/clock.js';

export const OWNER = '8801711111111';
export const STRANGER = '8801799999999';

export function tempDir(prefix = 'waop-'): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function makeConfig(overrides: Record<string, string> = {}): Config {
  const base = tempDir();
  const work = path.join(base, 'work');
  fs.mkdirSync(work, { recursive: true });
  return buildConfig(
    {
      CHANNEL: 'whatsapp',
      OPERATOR_WA_ID: OWNER,
      OPERATOR_ROOTS: work,
      META_APP_SECRET: 'app-secret-0123456789abcdef',
      META_VERIFY_TOKEN: 'verify-token-0123456789abcdef0123456789',
      WHATSAPP_ACCESS_TOKEN: 'access-token-0123456789abcdef',
      WHATSAPP_PHONE_NUMBER_ID: '1234567890',
      OPERATOR_PIN_FLOW_ID: '999',
      DATA_DIR: path.join(base, 'data'),
      LOG_LEVEL: 'silent',
      ...overrides,
    },
    base,
    path.join(base, 'app'),
  );
}

export function makeCtx(overrides: Record<string, string> = {}): AppContext & { clock: FakeClock } {
  const config = makeConfig(overrides);
  return {
    config,
    db: openDb(':memory:'),
    logger: silentLogger,
    clock: new FakeClock(Date.UTC(2026, 9, 13, 4, 0)), // 10:00 in Dhaka
    secrets: ['access-token-0123456789abcdef', 'app-secret-0123456789abcdef'],
  };
}

export type Sent =
  | { kind: 'text'; text: string }
  | { kind: 'buttons'; body: string; buttons: Button[] }
  | { kind: 'list'; body: string; rows: ListRow[] }
  | { kind: 'file'; path: string }
  | { kind: 'pin'; token: string; prompt: string }
  | { kind: 'react'; id: string; emoji: string }
  | { kind: 'template' };

/** Records everything sent to the owner. */
export class FakeChannel implements Channel {
  readonly name = 'whatsapp' as const;
  readonly maxText = 4096;
  sent: Sent[] = [];
  private n = 0;
  open = true;

  private id() {
    return `wamid.out${++this.n}`;
  }
  async sendText(text: string) {
    this.sent.push({ kind: 'text', text });
    return this.id();
  }
  async sendButtons(body: string, buttons: Button[]) {
    this.sent.push({ kind: 'buttons', body, buttons });
    return this.id();
  }
  async sendList(body: string, _b: string, rows: ListRow[]) {
    this.sent.push({ kind: 'list', body, rows });
    return this.id();
  }
  async sendFile(p: string) {
    this.sent.push({ kind: 'file', path: p });
    return this.id();
  }
  async requestPin(token: string, prompt: string) {
    this.sent.push({ kind: 'pin', token, prompt });
  }
  async react(id: string, emoji: string) {
    this.sent.push({ kind: 'react', id, emoji });
  }
  async downloadMedia() {
    return { data: Buffer.from('fake'), mime: 'application/pdf' };
  }
  async sendReopenTemplate() {
    this.sent.push({ kind: 'template' });
    return true;
  }
  windowOpen() {
    return this.open;
  }
  texts(): string[] {
    return this.sent.flatMap((s) => (s.kind === 'text' ? [s.text] : s.kind === 'buttons' ? [s.body] : []));
  }
  last<K extends Sent['kind']>(kind: K): Extract<Sent, { kind: K }> | undefined {
    return [...this.sent].reverse().find((s): s is Extract<Sent, { kind: K }> => s.kind === kind);
  }
}

export const flush = () => new Promise((r) => setImmediate(r));
