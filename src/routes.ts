/** Canonicalize page URLs without discarding meaningful query strings from links. */
export function canonicalPageUrl(value: string, base?: string): string {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported page URL');
  url.hash = '';
  url.search = '';
  url.username = '';
  url.password = '';
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/(index\.(?:html?|php))$/i, '/');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

const NON_PAGES = /\.(?:jpg|jpeg|png|gif|webp|svg|avif|ico|pdf|zip|mp4|mov|mp3|css|js|woff2?|ttf|otf|xml|json|txt)$/i;
const BLOCKED = /(?:^|\/)(?:wp-admin|wp-login\.php|wp-json|cart|checkout|my-account|account|order-pay|order-received|add-to-cart)(?:\/|$)/i;

export function isDiscoverablePage(raw: string, siteUrl: string, allowedOrigins: ReadonlySet<string>): boolean {
  try {
    const url = new URL(raw, siteUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !allowedOrigins.has(url.origin)) return false;
    if (url.username || url.password || url.search || NON_PAGES.test(url.pathname) || BLOCKED.test(url.pathname)) return false;
    return true;
  } catch { return false; }
}

/** Route names are based on the primary site's path, or explicit external seed host + path. */
export function localRoute(urlString: string, primaryOrigin: string): string {
  const url = new URL(canonicalPageUrl(urlString));
  const prefix = url.origin === primaryOrigin ? '' : `/external-${url.hostname.replace(/[^a-z0-9.-]/gi, '-')}`;
  const segments = url.pathname.split('/').filter(Boolean).map(s => encodeURIComponent(decodeURIComponent(s)));
  if (segments.some(s => s === '.' || s === '..')) throw new Error('Unsafe route path');
  return (prefix + '/' + segments.join('/') + '/').replace(/\/{2,}/g, '/');
}

export function rewriteInternalHref(raw: string, base: string, routes: ReadonlyMap<string, string>): string | undefined {
  try {
    const url = new URL(raw, base);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    const local = routes.get(canonicalPageUrl(url.href));
    return local ? `${local}${url.search}${url.hash}` : undefined;
  } catch { return undefined; }
}

export function isTransactionalLink(raw: string, text = ''): boolean {
  let url: URL | undefined;
  try { url = new URL(raw, 'https://placeholder.invalid'); } catch { /* ignore */ }
  return /(?:^|\/)(?:cart|checkout|order-pay|order-received|my-account)(?:\/|$)/i.test(url?.pathname ?? '') ||
    /(?:^|[?&])add-to-cart=/i.test(url?.search ?? '') ||
    /\b(?:add to cart|buy now|checkout|place order|complete purchase|purchase now)\b/i.test(text);
}
