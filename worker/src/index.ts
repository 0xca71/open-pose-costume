const ALLOWED_ORIGINS = new Set([
  'https://hongye007.github.io',
  'https://open-pose-costume.pages.dev',
]);

const UPSTREAMS = new Map([
  ['/site/v1/images/edits', 'https://atomflow.vip/v1/images/edits'],
  ['/api/v1/images/edits', 'https://api.atomflow.vip/v1/images/edits'],
  ['/openwego/v1/images/edits', 'https://openwego.com/v1/images/edits'],
]);

const MAX_REQUEST_BYTES = 96 * 1024 * 1024;

/**
 * Never trust a caller-supplied upstream without restricting both its host and path.
 * Custom providers must be public DNS hostnames, HTTPS on the default port,
 * and expose an OpenAI-compatible /v1/images/edits endpoint.
 * Do not accept IP literals, local aliases, credentials, queries or redirects.
 * For public sites, apply Cloudflare rate limits and optionally an account-level
 * egress/host allowlist as extra protection against proxy abuse.
 */
function customUpstream(requestUrl: URL): string | null {
  if (requestUrl.pathname !== '/custom/v1/images/edits') return null;
  if (requestUrl.searchParams.size !== 1 || requestUrl.searchParams.getAll('target').length !== 1)
    return null;
  const target = requestUrl.searchParams.get('target');
  if (!target || target.length > 2048) return null;

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }

  if (
    url.protocol !== 'https:' ||
    url.username || url.password || url.port || url.search || url.hash ||
    !/^\/(?:[a-zA-Z0-9._~-]+\/)*v1\/images\/edits$/.test(url.pathname)
  ) return null;

  const host = url.hostname.toLowerCase();
  // URL normalizes alternate IP forms like 127.1 and 0x7f000001; reject IP literals entirely.
  if (
    host.length > 253 ||
    host.includes(':') ||
    /^\d+(?:\.\d+)*$/.test(host) ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$/.test(host) ||
    /(?:^|\.)(?:nip\.io|sslip\.io|localtest\.me|lvh\.me)$/.test(host)
  ) return null;

  return url.href;
}

function corsHeaders(origin: string): Headers {
  return new Headers({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Expose-Headers': 'X-Oneapi-Request-Id',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  });
}

function errorResponse(status: number, code: string, origin?: string): Response {
  const headers = origin ? corsHeaders(origin) : new Headers();
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return Response.json({ error: { message: code } }, { status, headers });
}

export async function handleImageProxy(
  request: Request,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const isCustom = url.pathname === '/custom/v1/images/edits';
  const upstream = isCustom ? customUpstream(url) : UPSTREAMS.get(url.pathname);
  if (!upstream) return errorResponse(isCustom ? 400 : 404, isCustom ? 'invalid_target' : 'not_found');
  if (!isCustom && (url.search || url.hash)) return errorResponse(404, 'not_found');

  const origin = request.headers.get('Origin') || '';
  // Allow the deployment's own Origin (workers.dev or custom domain) without an open proxy.
  if (!ALLOWED_ORIGINS.has(origin) && origin !== url.origin)
    return errorResponse(403, 'origin_not_allowed');

  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== 'POST') return errorResponse(405, 'method_not_allowed', origin);

  const authorization = request.headers.get('Authorization') || '';
  if (!/^Bearer [^\r\n]{1,8192}$/.test(authorization))
    return errorResponse(401, 'missing_authorization', origin);

  const contentType = request.headers.get('Content-Type') || '';
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType))
    return errorResponse(415, 'multipart_required', origin);

  const contentLength = request.headers.get('Content-Length');
  if (contentLength) {
    const bytes = Number(contentLength);
    if (!Number.isSafeInteger(bytes) || bytes < 1)
      return errorResponse(400, 'invalid_content_length', origin);
    if (bytes > MAX_REQUEST_BYTES) return errorResponse(413, 'request_too_large', origin);
  }

  const headers = new Headers({
    Authorization: authorization,
    'Content-Type': contentType,
    Accept: 'application/json',
  });

  try {
    const response = await fetcher(upstream, {
      method: 'POST',
      headers,
      body: request.body,
      redirect: 'manual',
      signal: request.signal,
    });
    if (response.status >= 300 && response.status < 400)
      return errorResponse(502, 'upstream_redirect_rejected', origin);

    const responseHeaders = corsHeaders(origin);
    responseHeaders.set('Cache-Control', 'no-store');
    responseHeaders.set('X-Content-Type-Options', 'nosniff');
    const responseType = response.headers.get('Content-Type');
    const requestId = response.headers.get('X-Oneapi-Request-Id');
    if (responseType) responseHeaders.set('Content-Type', responseType);
    if (requestId) responseHeaders.set('X-Oneapi-Request-Id', requestId);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'image_proxy_upstream_failed',
        route: url.pathname,
        error: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
    return errorResponse(502, 'upstream_unreachable', origin);
  }
}

export default {
  fetch(request) {
    return handleImageProxy(request);
  },
} satisfies ExportedHandler;
