/**
 * Normalise an HTTP endpoint so `/api/user/1`, `/user/:id` and
 * `${base}/user/${id}` can be compared across frontend and backend repos.
 */
export function normalizeEndpoint(raw: string): string {
  let p = raw.replace(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i, '');
  // drop an interpolated base-url prefix: `${base}/api/items/${id}` -> `/api/items/${id}`
  p = p.replace(/^\s*\$\{[^}]*\}/, '');
  p = p.split('?')[0].split('#')[0];
  p = p.replace(/\$\{[^}]*\}/g, ':param');
  p = p.replace(/\{[^}]*\}/g, ':param');
  p = p.replace(/<[^>]*>/g, ':param');
  p = p.replace(/\/:\w+/g, '/:param');
  p = p.replace(/\/(\d+)(?=\/|$)/g, '/:param');
  p = p.replace(/\/+/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > 1) p = p.replace(/\/$/, '');
  return p.toLowerCase();
}
