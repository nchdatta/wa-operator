import { describe, expect, it } from 'vitest';
import { normalizeWaId, setEnvText } from '../src/shared/dotenv-edit.js';

describe('setup .env writer', () => {
  it('replaces keys in a Windows (CRLF) file without gluing them onto the comment above', () => {
    const src = '# owner number\r\nOPERATOR_WA_ID=8801700000000\r\n# name\r\n#BUSINESS_NAME=x\r\n';
    const out = setEnvText(src, { OPERATOR_WA_ID: '8801300421748', BUSINESS_NAME: 'A$1 Traders', CHANNEL: 'linked' });
    expect(out).toBe(
      '# owner number\r\nOPERATOR_WA_ID=8801300421748\r\n# name\r\nBUSINESS_NAME=A$1 Traders\r\nCHANNEL=linked\r\n',
    );
    expect(setEnvText('A=1\n', { A: '2' })).toBe('A=2\n');
  });

  it('owner numbers need a country code; local Bangladesh numbers get 88', () => {
    expect(normalizeWaId('01300-421748')).toBe('8801300421748');
    expect(normalizeWaId('+880 1300 421748')).toBe('8801300421748');
    expect(normalizeWaId('07700900123')).toBeNull();
    expect(normalizeWaId('447700900123')).toBe('447700900123');
  });
});
