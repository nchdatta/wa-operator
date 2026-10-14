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
    expect(plainReason('owner-confirmed tier for send_message')).toBe('it sends something from your account');
  });

  it('turns a long list of shell details into one short reason', () => {
    const r = plainReason(
      'variable $dir; grouping; variable $path; chained commands; add-type runs other code; unknown program if',
    );
    expect(r).toBe('it runs a script on your PC');
    expect(plainReason('chained commands; deletes inside the work folders')).toBe(
      'it deletes files, and it runs a script on your PC',
    );
  });

  it('describes commands by their purpose, not their text', () => {
    expect(
      plainAction('PowerShell', { command: 'Get-ChildItem C:/x | Select Name', description: 'List files in Shop' }),
    ).toBe('On your PC: List files in Shop');
    expect(plainAction('Bash', { command: 'git status --short' })).toBe('Run a program on your PC (git)');
  });

  it('shows who and what for sends', () => {
    expect(
      plainAction('mcp__claude_ai_Gmail__send_message', { to: 'a@b.com', subject: 'Invoice', body: 'Hi, attached.' }),
    ).toBe('Gmail: send message\nTo: a@b.com\nSubject: Invoice\n"Hi, attached."');
  });
});
