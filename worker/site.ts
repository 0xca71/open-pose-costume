import { handleImageProxy } from './src/index';

interface SiteEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

/** Route known image endpoints to the fixed-upstream proxy; otherwise serve static assets. */
export async function handleSiteRequest(
  request: Request,
  env: SiteEnv,
  upstreamFetch: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/__opc-image/')) {
    url.pathname = url.pathname.slice('/__opc-image'.length);
    return handleImageProxy(new Request(url, request), upstreamFetch);
  }
  return env.ASSETS.fetch(request);
}

export default {
  fetch(request: Request, env: SiteEnv) {
    return handleSiteRequest(request, env);
  },
};
