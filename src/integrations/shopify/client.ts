// Minimal Shopify Admin API client — REST, just what Phase 0 needs.
// We use REST (not GraphQL) for the bulk-sync path because the orders/customers/products
// resources paginate via Link headers in a single, predictable shape.

import { log } from '../../platform/log.js';

export interface ShopifyEnv {
  shopDomain: string;
  apiToken: string;
  apiVersion: string;
}

export function env(): ShopifyEnv {
  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  const apiToken = process.env.SHOPIFY_ADMIN_API_TOKEN;
  const apiVersion = process.env.SHOPIFY_API_VERSION ?? '2025-01';
  if (!shopDomain) throw new Error('SHOPIFY_SHOP_DOMAIN must be set');
  if (!apiToken)   throw new Error('SHOPIFY_ADMIN_API_TOKEN must be set');
  return { shopDomain, apiToken, apiVersion };
}

export interface PagedResult<T> {
  items: T[];
  nextPageInfo: string | null;
}

/** Fetch a single page of a paginated Admin REST resource. `path` is e.g. 'orders.json'. */
export async function getPage<T>(
  path: string,
  params: Record<string, string | number>,
): Promise<PagedResult<T>> {
  const { shopDomain, apiToken, apiVersion } = env();
  const url = new URL(`https://${shopDomain}/admin/api/${apiVersion}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    headers: {
      'X-Shopify-Access-Token': apiToken,
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`shopify ${path} ${res.status}: ${body.slice(0, 500)}`);
  }

  const body = (await res.json()) as Record<string, unknown>;
  const collectionKey = Object.keys(body)[0];
  const items = collectionKey ? ((body[collectionKey] as T[]) ?? []) : [];

  // Parse the next page cursor out of the Link header.
  const link = res.headers.get('Link') ?? res.headers.get('link');
  let nextPageInfo: string | null = null;
  if (link) {
    const m = link.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    if (m && m[1]) nextPageInfo = m[1];
  }

  log.debug('shopify.page', { path, count: items.length, hasNext: nextPageInfo !== null });

  return { items, nextPageInfo };
}

/**
 * Iterate every page of a Shopify resource. Lazily yields batches so callers can checkpoint
 * mid-stream without buffering the whole result set.
 */
export async function* iteratePages<T>(
  path: string,
  initialParams: Record<string, string | number>,
): AsyncGenerator<T[], void, void> {
  let pageInfo: string | null = null;
  do {
    const params: Record<string, string | number> = pageInfo
      ? { page_info: pageInfo, limit: initialParams.limit ?? 250 }
      : initialParams;
    const page = await getPage<T>(path, params);
    yield page.items;
    pageInfo = page.nextPageInfo;
  } while (pageInfo);
}
