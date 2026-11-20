import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const vite = await createServer({
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  appType: 'custom',
});
const { handleImageProxy } = await vite.ssrLoadModule('/worker/src/index.ts');
after(() => vite.close());

const workerUrl = 'https://proxy.example/site/v1/images/edits';
const allowedOrigin = 'https://hongye007.github.io';

test('worker preflight explicitly permits authorization from the production site', async () => {
  const response = await handleImageProxy(
    new Request(workerUrl, { method: 'OPTIONS', headers: { Origin: allowedOrigin } }),
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowedOrigin);
  assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Authorization, Content-Type');
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
});

test('worker permits a same-origin request on its own custom domain', async () => {
  const origin = 'https://open-pose-costume.example.workers.dev';
  const response = await handleImageProxy(
    new Request(`${origin}/site/v1/images/edits`, {
      method: 'OPTIONS',
      headers: { Origin: origin },
    }),
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
});

test('worker rejects unknown routes, foreign origins and oversized requests', async () => {
  assert.equal(
    (
      await handleImageProxy(
        new Request('https://proxy.example/other', {
          method: 'OPTIONS',
          headers: { Origin: allowedOrigin },
        }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await handleImageProxy(
        new Request(workerUrl, {
          method: 'OPTIONS',
          headers: { Origin: 'https://attacker.example' },
        }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handleImageProxy(
        new Request(workerUrl, {
          method: 'POST',
          headers: {
            Origin: allowedOrigin,
            Authorization: 'Bearer test-only',
            'Content-Type': 'multipart/form-data; boundary=test',
            'Content-Length': String(97 * 1024 * 1024),
          },
          body: '--test--',
        }),
      )
    ).status,
    413,
  );
});

test('worker streams multipart bytes to a fixed upstream without cookies', async () => {
  const form = new FormData();
  form.set('model', 'gpt-image-2');
  form.append('image[]', new Blob(['pose-original']), 'pose.png');
  const clientRequest = new Request(workerUrl, {
    method: 'POST',
    headers: {
      Origin: allowedOrigin,
      Authorization: 'Bearer test-only',
      Cookie: 'client-session=private',
    },
    body: form,
  });
  const expectedBytes = Buffer.from(await clientRequest.clone().arrayBuffer());
  let forwarded;
  const response = await handleImageProxy(clientRequest, async (input, init) => {
    forwarded = {
      url: String(input),
      headers: new Headers(init.headers),
      bytes: Buffer.from(await new Response(init.body).arrayBuffer()),
    };
    return Response.json(
      { error: { message: 'invalid test credential' } },
      {
        status: 401,
        headers: {
          'Set-Cookie': 'upstream=secret',
          'X-Oneapi-Request-Id': 'test-request-id',
        },
      },
    );
  });

  assert.equal(forwarded.url, 'https://atomflow.vip/v1/images/edits');
  assert.equal(forwarded.headers.get('Authorization'), 'Bearer test-only');
  assert.match(forwarded.headers.get('Content-Type'), /^multipart\/form-data; boundary=/);
  assert.equal(forwarded.headers.get('Cookie'), null);
  assert.deepEqual(forwarded.bytes, expectedBytes);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowedOrigin);
  assert.equal(response.headers.get('X-Oneapi-Request-Id'), 'test-request-id');
  assert.deepEqual(await response.json(), { error: { message: 'invalid test credential' } });
});

test('OpenWego routes to the fixed upstream, not an arbitrary URL', async () => {
  const origin = 'https://open-pose-costume.example.workers.dev';
  let destination = '';
  const form = new FormData();
  form.set('model', 'open-image-v2');
  const response = await handleImageProxy(
    new Request(`${origin}/openwego/v1/images/edits`, {
      method: 'POST',
      headers: { Origin: origin, Authorization: 'Bearer test-only' },
      body: form,
    }),
    async (input) => {
      destination = String(input);
      return Response.json({ ok: true });
    },
  );
  assert.equal(response.status, 200);
  assert.equal(destination, 'https://openwego.com/v1/images/edits');
});

test('custom provider safely forwards a public HTTPS image edit endpoint', async () => {
  const origin = 'https://open-pose-costume.example.workers.dev';
  const target = 'https://api.provider.example.org/custom/v1/images/edits';
  const form = new FormData();
  form.set('model', 'test');
  const request = new Request(
    `${origin}/custom/v1/images/edits?target=${encodeURIComponent(target)}`,
    {
      method: 'POST',
      headers: { Origin: origin, Authorization: 'Bearer test-only', Cookie: 'session=secret' },
      body: form,
    },
  );
  const originalBytes = Buffer.from(await request.clone().arrayBuffer());
  let forwarded = false;
  const response = await handleImageProxy(request, async (input, init) => {
    forwarded = true;
    assert.equal(String(input), target);
    assert.equal(init.redirect, 'manual');
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-only');
    assert.equal(new Headers(init.headers).get('Cookie'), null);
    assert.deepEqual(Buffer.from(await new Response(init.body).arrayBuffer()), originalBytes);
    return Response.json({ data: [] });
  });
  assert.equal(response.status, 200);
  assert.equal(forwarded, true);
});

test('custom provider rejects private, ambiguous and non-image upstream URLs', async () => {
  const origin = 'https://open-pose-costume.example.workers.dev';
  const denied = [
    'http://provider.example.org/v1/images/edits',
    'https://localhost/v1/images/edits',
    'https://127.0.0.1/v1/images/edits',
    'https://127.1/v1/images/edits',
    'https://[::1]/v1/images/edits',
    'https://192.168.1.2/v1/images/edits',
    'https://169.254.169.254/v1/images/edits',
    'https://10.7.0.1/v1/images/edits',
    'https://myserver.local/v1/images/edits',
    'https://service.internal/v1/images/edits',
    'https://localhost.nip.io/v1/images/edits',
    'https://provider.example.org:8443/v1/images/edits',
    'https://user:password@provider.example.org/v1/images/edits',
    'https://provider.example.org/admin',
    'https://provider.example.org/v1/images/edits?secret=1',
    'https://provider.example.org/v1/images/edits#fragment',
  ];
  for (const target of denied) {
    const request = new Request(
      `${origin}/custom/v1/images/edits?target=${encodeURIComponent(target)}`,
      { method: 'OPTIONS', headers: { Origin: origin } },
    );
    const result = await handleImageProxy(request, async () => {
      throw Error('invalid destination must not be fetched');
    });
    assert.equal(result.status, 400, target);
  }
  for (const suffix of ['?target=https%3A%2F%2Fgood.example.org%2Fv1%2Fimages%2Fedits&extra=1', '?target=1&target=2', '']) {
    const response = await handleImageProxy(
      new Request(`${origin}/custom/v1/images/edits${suffix}`, {
        method: 'OPTIONS', headers: { Origin: origin },
      }),
    );
    assert.equal(response.status, 400);
  }
});

test('custom provider retains same-origin, bearer auth and method protections', async () => {
  const origin = 'https://open-pose-costume.example.workers.dev';
  const target = 'https://api.provider.example.org/v1/images/edits';
  const url = `${origin}/custom/v1/images/edits?target=${encodeURIComponent(target)}`;
  const foreign = await handleImageProxy(new Request(url, {
    method: 'OPTIONS', headers: { Origin: 'https://attacker.example' },
  }));
  assert.equal(foreign.status, 403);
  const missingAuth = await handleImageProxy(new Request(url, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'multipart/form-data; boundary=test' },
    body: '--test--',
  }));
  assert.equal(missingAuth.status, 401);
  const forbiddenMethod = await handleImageProxy(new Request(url, {
    method: 'GET', headers: { Origin: origin },
  }));
  assert.equal(forbiddenMethod.status, 405);
});
