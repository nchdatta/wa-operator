#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import type { Server } from 'node:http';
import { createOperatorApp } from '../app.js';
import { BaileysChannel } from '../channels/baileys.js';
import type { Channel } from '../channels/channel.js';
import { TelegramChannel, TelegramPoller } from '../channels/telegram.js';
import { WhatsAppChannel } from '../channels/whatsapp.js';
import { ConfigError, loadConfig } from '../config/env.js';
import type { AppContext } from '../context.js';
import { MetaClient } from '../meta/client.js';
import { createLogger } from '../observability/logger.js';
import { openDb } from '../persistence/db.js';
import { storeJob } from '../runtime/jobs.js';
import { TunnelManager } from '../runtime/tunnel.js';
import { WhisperManager } from '../runtime/whisper.js';
import { ensureDataKey } from '../security/data-key.js';
import { SECRET_NAMES } from '../security/secrets.js';
import { systemClock } from '../shared/clock.js';
import { createWebhookApp } from '../webhook/app.js';

function isElevated(): boolean {
  if (process.platform !== 'win32') return process.getuid?.() === 0;
  return spawnSync('net', ['session'], { windowsHide: true, stdio: 'ignore' }).status === 0;
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    process.stderr.write(`${e instanceof ConfigError ? e.message : String(e)}\n`);
    process.exit(1);
  }
  const logger = createLogger({ level: config.LOG_LEVEL, file: config.logFile, name: 'wa-operator' });
  if (isElevated() && !config.OPERATOR_ALLOW_ADMIN) {
    logger.fatal('Operator Mode must not run with admin rights. Start it from a normal (non-elevated) session.');
    process.exit(1);
  }
  if (!config.CLAUDE_CODE_OAUTH_TOKEN) {
    logger.warn(
      'CLAUDE_CODE_OAUTH_TOKEN is not stored; using the existing Claude Code login. Run "wa-operator secret set CLAUDE_CODE_OAUTH_TOKEN".',
    );
  }
  // Voice notes: run the local whisper server alongside, so start/stop covers it too.
  const whisper = WhisperManager.wanted(config) ? new WhisperManager(config, logger) : undefined;
  if (whisper) config.WHISPER_URL = whisper.url;
  const db = openDb(config.databasePath, ensureDataKey(config.OPERATOR_DATA_KEY));
  const secrets = SECRET_NAMES.map((n) => config[n]).filter((v): v is string => !!v);
  const ctx: AppContext = { config, db, logger, clock: systemClock, secrets };

  let channel: Channel;
  let markRead: ((id: string) => Promise<void>) | undefined;
  let tunnel: TunnelManager | undefined;
  let poller: TelegramPoller | undefined;
  if (config.CHANNEL === 'whatsapp') {
    const client = new MetaClient({
      baseUrl: config.graphBaseUrl,
      accessToken: config.WHATSAPP_ACCESS_TOKEN!,
      appSecret: config.META_APP_SECRET!,
      appsecretProof: config.META_APPSECRET_PROOF,
      logger,
    });
    const wa = new WhatsAppChannel(client, config, logger);
    tunnel = new TunnelManager(ctx, client);
    channel = wa;
    markRead = (id) => wa.markRead(id);
    if (!config.OPERATOR_PIN_FLOW_ID)
      logger.warn('OPERATOR_PIN_FLOW_ID is not set: the PIN cannot be requested. See docs/setup.md.');
  } else if (config.CHANNEL === 'baileys') {
    const bl = new BaileysChannel(config, logger);
    channel = bl;
    markRead = (id) => bl.markRead(id);
  } else {
    channel = new TelegramChannel(config, logger);
  }

  const app = createOperatorApp(ctx, channel, markRead ? { markRead } : {});
  if (channel instanceof TelegramChannel) {
    poller = new TelegramPoller(channel, logger, (u) => {
      if (storeJob(ctx, 'telegram_update', `tg:${u.update_id}`, JSON.stringify(u))) app.processor.wake();
    });
  }

  const web = createWebhookApp(ctx, {
    onStored: () => app.processor.wake(),
    ready: () => {
      const s = app.gate.state();
      return {
        ok: true,
        checks: {
          enabled: s.enabled,
          unlocked: app.gate.isUnlocked(),
          busy: app.session.busy,
          channel: config.CHANNEL,
        },
      };
    },
  });
  const server: Server = web.listen(config.WEBHOOK_PORT, config.WEBHOOK_HOST, () =>
    logger.info(
      { host: config.WEBHOOK_HOST, port: config.WEBHOOK_PORT, channel: config.CHANNEL },
      'wa-operator listening',
    ),
  );

  if (channel instanceof BaileysChannel) {
    const bl = channel;
    bl.onMessage = (m) => {
      if (storeJob(ctx, 'baileys_message', `bl:${m.key.id}`, BaileysChannel.serialize(m))) app.processor.wake();
    };
    void bl.connect({
      onQr: () => logger.error('Baileys is not linked. Stop the service and run: wa-operator baileys link'),
    });
  }

  whisper?.start();
  await app.start();
  await tunnel?.start();
  void poller?.run();

  const shutdown = async (sig: string) => {
    logger.info({ sig }, 'shutting down');
    poller?.stop();
    if (channel instanceof BaileysChannel) channel.stop();
    tunnel?.stop();
    whisper?.stop();
    server.close();
    await app.stop();
    db.$client.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
