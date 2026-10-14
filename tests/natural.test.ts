import { describe, expect, it } from 'vitest';
import { parseYesNo } from '../src/approvals/engine.js';
import { naturalCommand } from '../src/inbound.js';

describe('everyday phrases', () => {
  it('map to shortcuts only when they are the whole message', () => {
    expect(naturalCommand('Stop')).toBe('/stop');
    expect(naturalCommand('stop please')).toBe('/stop');
    expect(naturalCommand('cancel 2')).toBe('/cancel 2');
    expect(naturalCommand('Cancel task #3')).toBe('/cancel 3');
    expect(naturalCommand("what's going on?")).toBe('/status');
    expect(naturalCommand('show tasks')).toBe('/queue');
    expect(naturalCommand('Start over')).toBe('/new');
    expect(naturalCommand("don't ask me")).toBe('/trust full');
    expect(naturalCommand('ask me first')).toBe('/trust off');
    expect(naturalCommand('help')).toBe('/help');
    expect(naturalCommand('থামো')).toBe('/stop');
    expect(naturalCommand('stop the backup script on the PC')).toBeNull();
    expect(naturalCommand('sold 3 bags rice 2400')).toBeNull();
  });

  it('typed answers to approval cards', () => {
    expect(parseYesNo('Approved')).toBe('a');
    expect(parseYesNo('ok please')).toBe('a');
    expect(parseYesNo('হ্যাঁ')).toBe('a');
    expect(parseYesNo('👍')).toBe('a');
    expect(parseYesNo('no')).toBe('r');
    expect(parseYesNo('না')).toBe('r');
    expect(parseYesNo('always')).toBe('w');
    expect(parseYesNo('ok and also check the price list')).toBeNull();
  });
});

describe('site names', () => {
  it('"open chatgpt" makes chatgpt.com a known site for the task', async () => {
    const { domainsIn } = await import('../src/operator/tiers.js');
    expect(domainsIn('open chatgpt and make a banner')).toContain('chatgpt.com');
    expect(domainsIn('check my linkedin')).toContain('linkedin.com');
    expect(domainsIn('sold 3 bags rice')).toEqual([]);
  });
});
