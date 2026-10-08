/** Schema route strings that resolve to the sample billing screen. */
const BILLING_ROUTES = new Set(['billing', 'billing/upgrade']);

/**
 * Maps a completionCta schema route to an Expo Router path, or `null` if unknown.
 */
export function resolveAppNavigateRoute(schemaRoute: string | null | undefined): string | null {
  if (schemaRoute == null || schemaRoute === '') return null;
  const normalized = schemaRoute.startsWith('/') ? schemaRoute.slice(1) : schemaRoute;
  if (BILLING_ROUTES.has(normalized)) return '/billing';
  return null;
}
