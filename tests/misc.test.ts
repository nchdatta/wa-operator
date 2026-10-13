import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WhatsAppChannel } from '../src/channels/whatsapp.js';
import type { Config } from '../src/config/env.js';
import type { MetaClient } from '../src/meta/client.js';
import { silentLogger } from '../src/observability/logger.js';
import { captureScreen } from '../src/operator/output.js';
import { Governor } from '../src/runtime/governor.js';
import { Gate } from '../src/operator/gate.js';
import { purgePaths } from '../src/shared/purge.js';
import { makeCtx, tempDir } from './helpers.js';

describe('WhatsApp PIN', () => {
  it('falls back to a text PIN when Meta blocks the Flow (139000)', async () => {
    const sent: Record<string, unknown>[] = [];
    const client = {
      request: async (r: { body?: Record<string, unknown> }) => {
        sent.push(r.body ?? {});
        if (r.body?.type === 'interactive') throw new Error('(#139000) Blocked by Integrity');
        return { messages: [{ id: `wamid.${sent.length}` }] };
      },
    } as unknown as MetaClient;
    const config = {
      OPERATOR_WA_ID: '8801700000000',
      WHATSAPP_PHONE_NUMBER_ID: '1',
      OPERATOR_PIN_FLOW_ID: '999',
      OPERATOR_PIN_FLOW_MODE: 'published',
    } as unknown as Config;
    const ch = new WhatsAppChannel(client, config, silentLogger);
    await ch.requestPin('tok', 'Unlock');
    expect(sent.map((s) => s.type)).toEqual(['interactive', 'text']);
    // Later requests skip the blocked Flow.
    await ch.requestPin('tok2', 'Unlock');
    expect(sent.at(-1)?.type).toBe('text');
    expect(ch.takeTextPin?.('4826', undefined)).toBe('tok2');
  });
});

describe('governor', () => {
  it('remembers a hit limit across a restart', async () => {
    const ctx = makeCtx();
    new Gate(ctx).state();
    const g = new Governor(ctx, async () => {});
    await g.update({ status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600 });
    const again = new Governor(ctx, async () => {});
    expect(again.level).toBe('limited');
    expect(again.canRunOwnerTask()).toBe(false);
  });
});

describe('uninstall --purge', () => {
  it('never deletes .env', () => {
    const root = tempDir();
    const paths = purgePaths(root);
    expect(paths.map((p) => path.basename(p))).toEqual(['data', 'logs', 'dist']);
    expect(paths.some((p) => p.includes('.env'))).toBe(false);
  });
});

describe('screenshot', () => {
  it.skipIf(process.platform !== 'win32' || process.env.CI)('captures the screen through -EncodedCommand', async () => {
    const file = path.join(tempDir(), 'shot.png');
    const r = await captureScreen(file);
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
  });
});
