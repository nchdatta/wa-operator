import { describe, expect, it } from 'vitest';
import { parseYesNo } from '../src/approvals/engine.js';
import { naturalCommand } from '../src/inbound.js';

describe('everyday phrases', () => {
  it('map to shortcuts only when they are the whole message', () => {
    expect(naturalCommand('Stop')).toBe('/stop');
    expect(naturalCommand('stop please')).toBe('/stop');
    expect(naturalCommand('cancel 2')).toBe('/cancel 2');
    expect(naturalCommand('Cancel task #3')).toBe('/cancel 3');
    expect(naturalCommand('status')).toBe('/status');
    expect(naturalCommand("what's going on?")).toBeNull();
    expect(naturalCommand('are you busy')).toBeNull();
    expect(naturalCommand('show tasks')).toBe('/queue');
    expect(naturalCommand('Start over')).toBe('/new');
    expect(naturalCommand('full trust')).toBe('/trust full');
    expect(naturalCommand('ask me first')).toBe('/trust off');
    expect(naturalCommand('help')).toBe('/help');
    expect(naturalCommand('থামো')).toBe('/stop');
    expect(naturalCommand('stp')).toBe('/stop');
    expect(naturalCommand('staus')).toBe('/status');
    expect(naturalCommand('কাজগুলা দেখাও')).toBe('/queue');
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
    expect(parseYesNo('stop')).toBeNull();
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

describe('recycle bin deletes', () => {
  it('a Recycle Bin move still asks in full trust', async () => {
    const { analyzeShell } = await import('../src/operator/shell.js');
    const cmd =
      "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('C:/Users/y/Documents/a.txt','OnlyErrorDialogs','SendToRecycleBin')";
    expect(analyzeShell(cmd, 'powershell', process.cwd(), { roots: [], denyPaths: [], denyNames: [] }).risks).toContain('deletes');
  });
});
