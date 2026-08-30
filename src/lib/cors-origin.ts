export function isAllowedCorsOrigin(
  origin: string | undefined,
  frontendUrl: string,
  publicSiteBaseDomain?: string,
  production = false,
) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (url.origin === new URL(frontendUrl).origin) return true;
    if (!publicSiteBaseDomain) return false;
    if (production && url.protocol !== "https:") return false;
    if (production && url.port && url.port !== "443") return false;
    if (!production && !["http:", "https:"].includes(url.protocol)) return false;
    const suffix = `.${publicSiteBaseDomain}`;
    if (!url.hostname.endsWith(suffix)) return false;
    const slug = url.hostname.slice(0, -suffix.length);
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
  } catch {
    return false;
  }
}
