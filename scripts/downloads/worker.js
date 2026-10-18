/**
 * Public download point for a private repo's releases. Clients have no GitHub login, so this Worker
 * fetches the latest release with a read-only token and streams the file:
 *   GET /install.ps1 | /install.sh | /wa-operator-<os>-<arch>.zip|.tar.gz | /SHA256SUMS.txt
 *   GET /latest   → {"version":"1.2.3"} for "wa-operator update"
 * Nothing else in the repo can be reached through it.
 */

const FILES = /^\/(install\.ps1|install\.sh|SHA256SUMS\.txt|wa-operator-(win|linux|darwin)-(x64|arm64)\.(zip|tar\.gz))$/;

async function latestRelease(env, ctx) {
  const cache = caches.default;
  const key = new Request('https://cache.internal/latest-release');
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/releases/latest`, {
    headers: gh(env, 'application/vnd.github+json'),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const body = await res.json();
  const release = {
    version: String(body.tag_name ?? '').replace(/^v/, ''),
    assets: Object.fromEntries((body.assets ?? []).map((a) => [a.name, a.url])),
  };
  // A minute is short enough that a new release shows up almost at once.
  ctx.waitUntil(
    cache.put(key, new Response(JSON.stringify(release), { headers: { 'cache-control': 'max-age=60' } })),
  );
  return release;
}

function gh(env, accept) {
  return { authorization: `Bearer ${env.GH_TOKEN}`, accept, 'user-agent': 'wa-operator-downloads' };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/latest') {
        const { version } = await latestRelease(env, ctx);
        return Response.json({ version }, { headers: { 'cache-control': 'no-store' } });
      }
      const m = FILES.exec(pathname);
      if (!m) return new Response('Not found', { status: 404 });
      const { assets } = await latestRelease(env, ctx);
      const api = assets[m[1]];
      if (!api) return new Response('Not in the latest release', { status: 404 });
      // GitHub answers with a redirect to short-lived storage; follow it without the token.
      const first = await fetch(api, { headers: gh(env, 'application/octet-stream'), redirect: 'manual' });
      const file = first.status >= 300 && first.status < 400 ? await fetch(first.headers.get('location')) : first;
      if (!file.ok) return new Response('Download failed', { status: 502 });
      const text = /\.(ps1|sh|txt)$/.test(m[1]);
      return new Response(request.method === 'HEAD' ? null : file.body, {
        headers: {
          'content-type': text ? 'text/plain; charset=utf-8' : 'application/octet-stream',
          ...(file.headers.get('content-length') ? { 'content-length': file.headers.get('content-length') } : {}),
          ...(text ? {} : { 'content-disposition': `attachment; filename="${m[1]}"` }),
          'cache-control': 'no-store',
        },
      });
    } catch (e) {
      return new Response(`Downloads are unavailable right now (${e.message}). Try again in a minute.`, { status: 503 });
    }
  },
};
