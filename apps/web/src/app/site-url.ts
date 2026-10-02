/**
 * The public origin of this deployment, for absolute metadata URLs. NEXT_PUBLIC_SITE_URL wins; on
 * Vercel the production domain is used; local builds fall back to localhost. Read at build time.
 */
export function siteUrl(): URL {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return new URL(configured);
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) return new URL(`https://${vercel}`);
  return new URL("http://localhost:3000");
}
