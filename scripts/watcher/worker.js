// Cloudflare Worker (free plan) that watches the shop PC from outside.
// A PC that is down cannot report itself, so this pings the health URL every 5 minutes
// and sends the owner a WhatsApp template when it stops answering (and once when it is back).
//
// Bindings (wrangler.toml): KV namespace WATCH; secret WHATSAPP_ACCESS_TOKEN;
// vars HEALTH_URL, PHONE_NUMBER_ID, OWNER_WA_ID, OFFLINE_TEMPLATE, ONLINE_TEMPLATE, TEMPLATE_LANG.

async function sendTemplate(env, name) {
  if (!name) return;
  const res = await fetch(`https://graph.facebook.com/v24.0/${env.PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: env.OWNER_WA_ID,
      type: 'template',
      template: { name, language: { code: env.TEMPLATE_LANG || 'en' } },
    }),
  });
  if (!res.ok) console.log('template send failed', res.status, await res.text());
}

async function check(env) {
  let up = false;
  try {
    const res = await fetch(env.HEALTH_URL, { signal: AbortSignal.timeout(10_000) });
    up = res.ok;
  } catch {
    up = false;
  }
  const prev = JSON.parse((await env.WATCH.get('state')) || '{"up":true,"fails":0}');
  const fails = up ? 0 : prev.fails + 1;
  let isUp = prev.up;
  // Two misses in a row (10 minutes) before calling it offline, so a Windows Update reboot stays quiet.
  if (prev.up && fails >= 2) {
    isUp = false;
    await sendTemplate(env, env.OFFLINE_TEMPLATE);
  } else if (!prev.up && up) {
    isUp = true;
    await sendTemplate(env, env.ONLINE_TEMPLATE);
  }
  await env.WATCH.put('state', JSON.stringify({ up: isUp, fails, at: Date.now() }));
  return { up, isUp, fails };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(check(env));
  },
  async fetch(_req, env) {
    return Response.json(await check(env));
  },
};
