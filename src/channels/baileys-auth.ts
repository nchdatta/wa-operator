import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from 'baileys';
import { decryptBytes, encryptBytes, isEncrypted } from '../security/data-key.js';

/**
 * Baileys' multi-file auth state, but every file is AES-256-GCM encrypted. Plain files left by an
 * older version are read once and rewritten encrypted.
 */
export async function useEncryptedAuthState(
  folder: string,
  key: Buffer,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  await fs.mkdir(folder, { recursive: true });
  const locks = new Map<string, Promise<unknown>>();
  const file = (name: string) => path.join(folder, name.replace(/\//g, '__').replace(/:/g, '-'));
  /** One operation at a time per file. */
  const locked = <T>(p: string, fn: () => Promise<T>): Promise<T> => {
    const next = (locks.get(p) ?? Promise.resolve()).catch(() => undefined).then(fn);
    locks.set(p, next);
    return next;
  };

  const write = (name: string, data: unknown) => {
    const p = file(name);
    return locked(p, async () => {
      const tmp = `${p}.tmp`;
      await fs.writeFile(tmp, encryptBytes(key, Buffer.from(JSON.stringify(data, BufferJSON.replacer))));
      await fs.rename(tmp, p);
    });
  };
  const read = async <T>(name: string): Promise<T | null> => {
    const p = file(name);
    const buf = await locked(p, () => fs.readFile(p)).catch(() => null);
    if (!buf) return null;
    if (isEncrypted(buf)) return JSON.parse(decryptBytes(key, buf).toString('utf8'), BufferJSON.reviver) as T;
    const value = JSON.parse(buf.toString('utf8'), BufferJSON.reviver) as T;
    await write(name, value);
    return value;
  };
  const remove = (name: string) => {
    const p = file(name);
    return locked(p, () => fs.unlink(p)).catch(() => undefined);
  };

  // Encrypt every plain file left by an older version now, not only the ones read later.
  for (const name of await fs.readdir(folder)) {
    if (!name.endsWith('.json')) continue;
    const buf = await fs.readFile(path.join(folder, name));
    if (!isEncrypted(buf)) await write(name, JSON.parse(buf.toString('utf8'), BufferJSON.reviver));
  }

  const creds = (await read<AuthenticationCreds>('creds.json')) ?? initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const out: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await read<SignalDataTypeMap[T]>(`${type}-${id}.json`);
              if (type === 'app-state-sync-key' && value)
                value = proto.Message.AppStateSyncKeyData.fromObject(
                  value as Record<string, unknown>,
                ) as unknown as SignalDataTypeMap[T];
              if (value) out[id] = value;
            }),
          );
          return out;
        },
        set: async (data) => {
          const tasks: Promise<unknown>[] = [];
          for (const category in data) {
            const items = data[category as keyof SignalDataTypeMap] ?? {};
            for (const id in items) {
              const value = items[id];
              tasks.push(value ? write(`${category}-${id}.json`, value) : remove(`${category}-${id}.json`));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write('creds.json', creds),
  };
}
