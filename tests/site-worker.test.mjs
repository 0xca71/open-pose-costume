import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const vite = await createServer({
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  appType: 'custom',
});
const { handleSiteRequest } = await vite.ssrLoadModule('/worker/site.ts');
after(() => vite.close());

const origin = 'https://open-pose-costume.example.workers.dev';
const proxyUrl = `${origin}/__opc-image/site/v1/images/edits`;

function assets() {
  const requests = [];
  return {
    requests,
    env: {
      ASSETS: {
        async fetch(request) {
          requests.push(request.url);
          return new Response('static asset', { status: 200 });
        },
      },
    },
  };
}

test('static pages use the ASSETS binding', async () => {
  const { env, requests } = assets();
  const response = await handleSiteRequest(new Request(`${origin}/guide/`), env);
  assert.equal(await response.text(), 'static asset');
  assert.deepEqual(requests, [`${origin}/guide/`]);
});

test('single Worker forwards same-origin image edits to fixed Atomflow upstream', async () => {
  const { env, requests } = assets();
  const form = new FormData();
  form.set('model', 'test-model');
  form.append('image[]', new Blob(['pose-original']), 'pose.png');
  const request = new Request(proxyUrl, {
    method: 'POST',
    headers: { Origin: origin, Authorization: 'Bearer example-key', Cookie: 'session=private' },
    body: form,
  });
  const originalBody = Buffer.from(await request.clone().arrayBuffer());
  let forwarded = 0;
  const response = await handleSiteRequest(request, env, async (url, init) => {
    forwarded++;
    assert.equal(String(url), 'https://atomflow.vip/v1/images/edits');
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer example-key');
    assert.equal(new Headers(init.headers).get('Cookie'), null);
    assert.deepEqual(Buffer.from(await new Response(init.body).arrayBuffer()), originalBody);
    return Response.json({ ok: true });
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(forwarded, 1);
  assert.equal(requests.length, 0);
});

test('single Worker uses same-origin OpenWego proxy', async () => {
  const { env, requests } = assets();
  let destination = '';
  const form = new FormData();
  form.set('model', 'open-image-v2');
  const response = await handleSiteRequest(
    new Request(`${origin}/__opc-image/openwego/v1/images/edits`, {
      method: 'POST',
      headers: { Origin: origin, Authorization: 'Bearer test-only' },
      body: form,
    }),
    env,
    async (input) => {
      destination = String(input);
      return Response.json({ ok: true });
    },
  );
  assert.equal(response.status, 200);
  assert.equal(destination, 'https://openwego.com/v1/images/edits');
  assert.deepEqual(requests, []);
});

test('single Worker forwards a validated custom provider using the same-origin namespace', async () => {
  const { env, requests } = assets();
  const target = 'https://image-api.provider.example.org/v1/images/edits';
  const form = new FormData();
  form.set('model', 'custom-model');
  const response = await handleSiteRequest(
    new Request(`${origin}/__opc-image/custom/v1/images/edits?target=${encodeURIComponent(target)}`, {
      method: 'POST',
      headers: { Origin: origin, Authorization: 'Bearer local-only' },
      body: form,
    }),
    env,
    async (input) => {
      assert.equal(String(input), target);
      return Response.json({ data: [] });
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(requests, []);
});

test('proxy namespace rejects foreign origins, unknown routes and query strings', async () => {
  const { env, requests } = assets();
  const forbidden = await handleSiteRequest(
    new Request(proxyUrl, { method: 'OPTIONS', headers: { Origin: 'https://attacker.example' } }),
    env,
  );
  assert.equal(forbidden.status, 403);
  const unknown = await handleSiteRequest(
    new Request(`${origin}/__opc-image/anything`, { method: 'OPTIONS', headers: { Origin: origin } }),
    env,
  );
  assert.equal(unknown.status, 404);
  const query = await handleSiteRequest(
    new Request(`${proxyUrl}?destination=other`, {
      method: 'OPTIONS',
      headers: { Origin: origin },
    }),
    env,
  );
  assert.equal(query.status, 404);
  assert.deepEqual(requests, []);
});
