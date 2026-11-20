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

/** Restrict the proxy to known provider origins and one exact image-edit endpoint. */
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

/** Route only fixed-destination image edits through the proxy, never arbitrary providers. */
export function imageRequestEndpoint(
  endpoint: string,
  development: boolean,
  productionProxy = '',
): string {
  const route = imageProxyRoute(endpoint);
  if (!route) return endpoint;
  if (development) return `/__opc-image/${route}/v1/images/edits`;
  const destination = productionProxy.trim();
  // Only an explicit opt-out uses direct requests; missing/empty build variables are safe.
  if (destination === 'direct') return endpoint;
  if (!destination || destination === '/__opc-image') return `/__opc-image/${route}/v1/images/edits`;
  const proxy = new URL(destination);
  if (proxy.protocol !== 'https:' || proxy.username || proxy.password || proxy.search || proxy.hash)
    throw new Error('invalidProxyEndpoint');
  const pathname = proxy.pathname.replace(/\/+$/, '');
  return `${proxy.origin}${pathname}/${route}/v1/images/edits`;
}
