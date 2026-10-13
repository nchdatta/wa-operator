import { BufferJSON, type WAMessage } from 'baileys';
import { describe, expect, it } from 'vitest';
import { BaileysChannel } from '../src/channels/baileys.js';
import { silentLogger } from '../src/observability/logger.js';
import { makeConfig, OWNER } from './helpers.js';

function msg(id: string, message: WAMessage['message'], remoteJid = `${OWNER}@s.whatsapp.net`): string {
  return JSON.stringify(
    { key: { id, remoteJid, fromMe: false }, message, messageTimestamp: 1_800_000_000 },
    BufferJSON.replacer,
  );
}

function channel(): BaileysChannel {
  const ch = new BaileysChannel(makeConfig({ CHANNEL: 'baileys' }), silentLogger);
  // Pretend to be connected: sends return a fake ID.
  (ch as unknown as { send: () => Promise<string> }).send = async () => 'OUT1';
  return ch;
}

describe('BaileysChannel', () => {
  it('normalizes text from the owner, preferring the phone-number JID over a LID', () => {
    const ch = channel();
    const raw = JSON.stringify({
      key: { id: 'A1', remoteJid: '123456@lid', remoteJidAlt: `${OWNER}@s.whatsapp.net`, fromMe: false },
      message: { conversation: 'hello' },
      messageTimestamp: 1_800_000_000,
    });
    expect(ch.normalize(raw)).toMatchObject({ channel: 'baileys', id: 'A1', from: OWNER, text: 'hello' });
  });

  it('maps a menu number to the button ID, once', async () => {
    const ch = channel();
    await ch.sendButtons('Allow?', [
      { id: 'ok', title: 'Yes' },
      { id: 'no', title: 'No' },
    ]);
    expect(ch.normalize(msg('B1', { conversation: '2' }))?.button).toEqual({ id: 'no' });
    expect(ch.normalize(msg('B2', { conversation: '2' }))?.text).toBe('2');
  });

  it('takes a PIN reply for an open prompt', async () => {
    const ch = channel();
    await ch.requestPin('tok', 'Unlock?');
    expect(ch.takeTextPin('1234', 'OUT1')).toBe('tok');
    expect(ch.takeTextPin('1234', 'OUT1')).toBeNull();
  });

  it('reports media with the message ID as ref', () => {
    const ch = channel();
    const m = ch.normalize(msg('C1', { imageMessage: { mimetype: 'image/jpeg', caption: 'bill' } }));
    expect(m?.media).toMatchObject({ kind: 'image', ref: 'C1', mime: 'image/jpeg', caption: 'bill' });
  });
});
