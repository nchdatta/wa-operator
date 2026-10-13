import readline from 'node:readline/promises';

/** Small terminal prompts for the CLI and the setup wizard. */

export async function ask(question: string, def?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(def ? `${question} [${def}]: ` : `${question}: `)).trim();
    return a || def || '';
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, def = true): Promise<boolean> {
  const a = (await ask(`${question} (${def ? 'Y/n' : 'y/N'})`)).toLowerCase();
  return a ? a.startsWith('y') : def;
}

export async function askHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return ask(prompt);
  process.stdout.write(`${prompt}: `);
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const done = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stdout.write('\n');
    };
    const onData = (raw: string) => {
      // Drop terminal escape sequences (focus events, device replies) that arrive in raw mode.
      // eslint-disable-next-line no-control-regex
      const ch = raw.replace(/\x1b(\[[0-9;?]*[ -/]*[@-~]|O.|[@-Z\-_])/g, '');
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          done();
          return resolve(value.trim());
        }
        if (c === '\u0003') {
          done();
          return reject(new Error('cancelled'));
        }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else if (c >= ' ') value += c;
      }
    };
    process.stdin.on('data', onData);
  });
}
