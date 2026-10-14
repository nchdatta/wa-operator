import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { AppContext } from '../context.js';
import type { MetaClient } from '../meta/client.js';
import { errMsg } from '../shared/errors.js';

/**
 * Public URL for the Meta webhook.
 * - quick: a free trycloudflare.com tunnel started here. Its URL changes on every start, so the webhook
 *   is re-registered each time (and again if cloudflared restarts).
 * - named: a stable hostname served by a separately running named tunnel.
 *
 * Registration is a per-WhatsApp-Business-Account override (override_callback_uri), so other projects on
 * the same Meta app keep their own app-wide webhook.
 */

export function findCloudflared(configured?: string): string | null {
  if (configured) return configured;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout.split(/\r?\n/)[0]?.trim() ?? null) : null;
}

export async function registerWebhookOverride(
  client: MetaClient,
  wabaId: string,
  callbackUrl: string,
  verifyToken: string,
): Promise<void> {
  // Meta only accepts an override once the app is subscribed to the account.
  await client.request({ method: 'POST', path: `/${wabaId}/subscribed_apps` });
  await client.request({
    method: 'POST',
    path: `/${wabaId}/subscribed_apps`,
    body: { override_callback_uri: callbackUrl, verify_token: verifyToken },
  });
}

async function reachable(url: string, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(4000) })).ok) return true;
    } catch {
      // DNS for a new trycloudflare host takes a few seconds
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export class TunnelManager {
  private proc: ChildProcess | null = null;
  private stopped = false;
  url: string | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly client: MetaClient,
  ) {}

  private async register(base: string): Promise<void> {
    const c = this.ctx.config;
    if (!c.WHATSAPP_BUSINESS_ACCOUNT_ID) {
      this.ctx.logger.warn('WHATSAPP_BUSINESS_ACCOUNT_ID not set: webhook not registered');
      return;
    }
    const callback = `${base}${c.WEBHOOK_PATH}`;
    // Local DNS can lag behind a new trycloudflare host; Meta's own check is what counts, so only wait a bit.
    if (!(await reachable(`${base}/health/live`, 20)))
      this.ctx.logger.warn({ base }, 'tunnel not visible from this PC yet');
    await this.ensureAppWebhook(callback);
    for (let attempt = 1; attempt <= 6 && !this.stopped && this.url === base; attempt++) {
      try {
        await registerWebhookOverride(this.client, c.WHATSAPP_BUSINESS_ACCOUNT_ID, callback, c.META_VERIFY_TOKEN!);
        this.ctx.logger.info({ callback }, 'webhook registered for this WhatsApp Business Account');
        return;
      } catch (e) {
        this.ctx.logger.warn({ err: errMsg(e), attempt }, 'webhook registration failed, retrying');
        await new Promise((r) => setTimeout(r, 15_000));
      }
    }
    this.ctx.logger.error({ callback }, 'webhook registration gave up');
  }

  /**
   * Meta accepts a per-account override only if the app has an app-level WhatsApp webhook. Set one only
   * when none exists, so an app-wide webhook another project relies on is never replaced.
   */
  private async ensureAppWebhook(callback: string): Promise<void> {
    const c = this.ctx.config;
    if (!c.META_APP_ID || !c.META_APP_SECRET) return;
    const appToken = `${c.META_APP_ID}|${c.META_APP_SECRET}`;
    const base = c.graphBaseUrl;
    try {
      const r = await fetch(`${base}/${c.META_APP_ID}/subscriptions?access_token=${encodeURIComponent(appToken)}`);
      const j = (await r.json()) as { data?: { object: string }[] };
      if (j.data?.some((d) => d.object === 'whatsapp_business_account')) return;
      const body = new URLSearchParams({
        object: 'whatsapp_business_account',
        callback_url: callback,
        verify_token: c.META_VERIFY_TOKEN!,
        fields: 'messages',
        access_token: appToken,
      });
      const res = await fetch(`${base}/${c.META_APP_ID}/subscriptions`, { method: 'POST', body });
      if (res.ok) this.ctx.logger.info('app-level WhatsApp webhook created (there was none)');
      else
        this.ctx.logger.warn(
          { status: res.status, body: (await res.text()).slice(0, 300) },
          'app-level webhook not created',
        );
    } catch (e) {
      this.ctx.logger.warn({ err: errMsg(e) }, 'app-level webhook check failed');
    }
  }

  async start(): Promise<void> {
    const c = this.ctx.config;
    if (c.CHANNEL !== 'whatsapp') return;
    if (c.TUNNEL_MODE === 'named' && c.PUBLIC_HOSTNAME) {
      this.url = `https://${c.PUBLIC_HOSTNAME}`;
      void this.register(this.url);
    } else if (c.TUNNEL_MODE === 'quick') {
      this.spawnQuick();
    }
  }

  private spawnQuick(): void {
    const bin = findCloudflared(this.ctx.config.CLOUDFLARED_BIN);
    if (!bin) {
      this.ctx.logger.error('cloudflared not found (install it: winget install Cloudflare.cloudflared, brew install cloudflared, or the Linux package; or set CLOUDFLARED_BIN)');
      return;
    }
    const target = `http://127.0.0.1:${this.ctx.config.WEBHOOK_PORT}`;
    const p = spawn(bin, ['tunnel', '--no-autoupdate', '--url', target], { windowsHide: true });
    this.proc = p;
    let found = false;
    const onData = (d: Buffer) => {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(d.toString());
      if (m && !found) {
        found = true;
        this.url = m[0];
        this.ctx.logger.info({ url: this.url }, 'quick tunnel up');
        void this.register(this.url);
      }
    };
    p.stdout?.on('data', onData);
    p.stderr?.on('data', onData);
    p.on('exit', (code) => {
      if (this.proc === p) this.proc = null;
      if (this.stopped) return;
      this.ctx.logger.warn({ code }, 'quick tunnel exited; restarting in 10 s');
      setTimeout(() => !this.stopped && this.spawnQuick(), 10_000);
    });
  }

  stop(): void {
    this.stopped = true;
    this.proc?.kill();
  }
}
