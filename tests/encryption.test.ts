import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { BufferJSON, initAuthCreds } from 'baileys';
import { describe, expect, it } from 'vitest';
import { useEncryptedAuthState } from '../src/channels/baileys-auth.js';
import { openDb } from '../src/persistence/db.js';
import { isEncrypted, subKey } from '../src/security/data-key.js';
import { tempDir } from './helpers.js';

const KEY = crypto.randomBytes(32).toString('hex');

describe('data at rest', () => {
  it('stores the database encrypted', () => {
    const file = path.join(tempDir(), 'op.db');
    const db = openDb(file, KEY);
    db.$client.exec("CREATE TABLE secret_probe(x); INSERT INTO secret_probe VALUES ('owner-secret-text')");
    db.$client.pragma('wal_checkpoint(TRUNCATE)');
    db.$client.close();
    expect(fs.readFileSync(file).includes('owner-secret-text')).toBe(false);
    const raw = new Database(file);
    expect(() => raw.prepare('SELECT * FROM sqlite_master').get()).toThrow();
    raw.close();
    const again = openDb(file, KEY);
    expect(again.$client.prepare('SELECT x FROM secret_probe').get()).toEqual({ x: 'owner-secret-text' });
    again.$client.close();
  });

  it('encrypts an old plain database in place', () => {
    const file = path.join(tempDir(), 'op.db');
    const plain = new Database(file);
    plain.exec("CREATE TABLE old(x); INSERT INTO old VALUES ('kept-text')");
    plain.close();
    const db = openDb(file, KEY);
    expect(db.$client.prepare('SELECT x FROM old').get()).toEqual({ x: 'kept-text' });
    db.$client.close();
    expect(fs.readFileSync(file).includes('kept-text')).toBe(false);
  });

  it('refuses a database encrypted with another key', () => {
    const file = path.join(tempDir(), 'op.db');
    openDb(file, KEY).$client.close();
    expect(() => openDb(file, crypto.randomBytes(32).toString('hex'))).toThrow(/data key/);
  });

  it('encrypts the WhatsApp link session and upgrades plain files', async () => {
    const dir = tempDir();
    const key = subKey(KEY, 'baileys-auth');
    fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify(initAuthCreds(), BufferJSON.replacer));
    const { state, saveCreds } = await useEncryptedAuthState(dir, key);
    await state.keys.set({ 'pre-key': { '1': { public: Buffer.from('pub'), private: Buffer.from('priv') } } });
    await saveCreds();
    for (const f of fs.readdirSync(dir)) expect(isEncrypted(fs.readFileSync(path.join(dir, f)))).toBe(true);
    const reopened = await useEncryptedAuthState(dir, key);
    expect(reopened.state.creds.registrationId).toBe(state.creds.registrationId);
    const got = await reopened.state.keys.get('pre-key', ['1']);
    expect(Buffer.from(got['1']!.private).toString()).toBe('priv');
  });
});
