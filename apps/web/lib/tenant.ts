// Which business is this request for? Decided on the server from the host name, never from user input.

export type TenantEnv = { defaultSlug?: string; rootDomain?: string };

const SLUG = /^[a-z0-9-]{2,40}$/;

/**
 * - If a root domain is configured (ratib.app), "acme.ratib.app" -> "acme".
 * - Otherwise (local development, single-business deployments) use the default slug.
 * Reserved subdomains never resolve to a tenant.
 */
export function resolveOrgSlug(host: string | null | undefined, env: TenantEnv): string | null {
  const cleanHost = (host ?? '').toLowerCase().split(':')[0].trim();
  const root = (env.rootDomain ?? '').toLowerCase().trim();

  if (root && cleanHost.endsWith(`.${root}`)) {
    const sub = cleanHost.slice(0, cleanHost.length - root.length - 1);
    if (!sub.includes('.') && SLUG.test(sub) && !['www', 'app', 'api', 'admin', 'platform'].includes(sub)) return sub;
    return null;
  }
  const fallback = (env.defaultSlug ?? '').toLowerCase().trim();
  return SLUG.test(fallback) ? fallback : null;
}

/** Only allow redirects back into our own site. Returns null when there is nothing safe to use. */
export function safeNextPathOrNull(next: string | null | undefined): string | null {
  if (!next || typeof next !== 'string') return null;
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\') || next.includes('://')) return null;
  return next;
}

export function safeNextPath(next: string | null | undefined): string {
  return safeNextPathOrNull(next) ?? '/portal/dashboard';
}
