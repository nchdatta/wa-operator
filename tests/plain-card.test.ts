import { describe, expect, it } from 'vitest';
import { plainAction, plainReason } from '../src/approvals/engine.js';

describe('approval card text', () => {
  it('never shows code for browser scripts', () => {
    const text = plainAction('mcp__browser__browser_evaluate', {
      function: '() => { return document.body.innerText; }',
    });
    expect(text).toBe('Read information from the open web page in the browser');
  });

  it('uses plain reasons', () => {
    expect(
      plainReason(
        'new tool mcp__browser__browser_evaluate (suggested HIGH; confirm on the PC with "wa-operator tiers")',
      ),
    ).toBe('first time using this tool');
  });

  it('describes commands by their purpose, not their text', () => {
    expect(
      plainAction('PowerShell', { command: 'Get-ChildItem C:/x | Select Name', description: 'List files in Shop' }),
    ).toBe('Run a command on the PC: List files in Shop');
    expect(plainAction('Bash', { command: 'git status --short' })).toBe('Run a command on the PC (git)');
  });

  it('shows who and what for sends', () => {
    expect(
      plainAction('mcp__claude_ai_Gmail__send_message', { to: 'a@b.com', subject: 'Invoice', body: 'Hi, attached.' }),
    ).toBe('Gmail: send message\nTo: a@b.com\nSubject: Invoice\n"Hi, attached."');
  });
});
