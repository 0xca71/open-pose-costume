export function atomflowRoute(endpoint: string): 'site' | 'api' | null {
  const url = new URL(endpoint);
  return url.pathname === '/v1/images/edits' && !url.search && !url.hash
    ? url.origin === 'https://atomflow.vip'
      ? 'site'
      : url.origin === 'https://api.atomflow.vip'
        ? 'api'
        : null
    : null;
}

/** Keep known providers on fixed upstreams; other providers use a validated custom route. */
export function imageProxyRoute(endpoint: string): 'site' | 'api' | 'openwego' | null {
  const atomflow = atomflowRoute(endpoint);
  if (atomflow) return atomflow;
  const url = new URL(endpoint);
  return url.origin === 'https://openwego.com' &&
    url.pathname === '/v1/images/edits' &&
    !url.search &&
    !url.hash
    ? 'openwego'
    : null;
}

/**
 * Production requests default to the same-origin Worker, including custom providers.
 * Local Vite development proxies the known providers; custom URLs stay direct locally.
 * Use VITE_IMAGE_PROXY_URL=direct to explicitly bypass the Worker everywhere.
 */
export function imageRequestEndpoint(
  endpoint: string,
  development: boolean,
  productionProxy = '',
): string {
  const destination = productionProxy.trim();
  if (destination === 'direct') return endpoint;

  const route = imageProxyRoute(endpoint);
  if (development && !route) return endpoint;

  const path = route
    ? `/${route}/v1/images/edits`
    : `/custom/v1/images/edits?target=${encodeURIComponent(endpoint)}`;
  if (development || !destination || destination === '/__opc-image')
    return `/__opc-image${path}`;

  const proxy = new URL(destination);
  if (proxy.protocol !== 'https:' || proxy.username || proxy.password || proxy.search || proxy.hash)
    throw new Error('invalidProxyEndpoint');
  const pathname = proxy.pathname.replace(/\/+$/, '');
  return `${proxy.origin}${pathname}${path}`;
}
