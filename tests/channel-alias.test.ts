import { describe, expect, it } from 'vitest';
import { makeConfig } from './helpers.js';

describe('CHANNEL names', () => {
  it('accepts the friendly names and the older ones', () => {
    expect(makeConfig({ CHANNEL: 'linked' }).CHANNEL).toBe('baileys');
    expect(makeConfig({ CHANNEL: 'Cloud' }).CHANNEL).toBe('whatsapp');
    expect(makeConfig({ CHANNEL: 'baileys' }).CHANNEL).toBe('baileys');
    expect(
      makeConfig({
        CHANNEL: 'telegram',
        TELEGRAM_BOT_TOKEN: '123456:telegram-token-abcdefghij',
        TELEGRAM_OPERATOR_USER_ID: '1',
      }).CHANNEL,
    ).toBe('telegram');
    expect(() => makeConfig({ CHANNEL: 'sms' })).toThrow();
  });
});
