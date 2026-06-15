// Register Shopify read-only tools in the platform tool registry. Mutating Shopify tools
// (product writes, inventory writes, etc.) are not in scope for Phase 0.

import { registerTool } from '../../platform/tools/registry.js';
import { getPage } from './client.js';

let registered = false;

export function registerShopifyTools(): void {
  if (registered) return;

  registerTool({
    name: 'shopify.list_orders',
    defaultRisk: 'auto',
    mutating: false,
    execute: async (input: { since?: string; limit?: number } = {}) => {
      const params: Record<string, string | number> = {
        limit: input.limit ?? 50,
        status: 'any',
      };
      if (input.since) params.updated_at_min = input.since;
      const page = await getPage<Record<string, unknown>>('orders.json', params);
      return page.items;
    },
  });

  registerTool({
    name: 'shopify.list_customers',
    defaultRisk: 'auto',
    mutating: false,
    execute: async (input: { limit?: number } = {}) => {
      const page = await getPage<Record<string, unknown>>('customers.json', {
        limit: input.limit ?? 50,
      });
      return page.items;
    },
  });

  registerTool({
    name: 'shopify.list_products',
    defaultRisk: 'auto',
    mutating: false,
    execute: async (input: { limit?: number } = {}) => {
      const page = await getPage<Record<string, unknown>>('products.json', {
        limit: input.limit ?? 50,
      });
      return page.items;
    },
  });

  registerTool({
    name: 'shopify.list_fulfillments',
    defaultRisk: 'auto',
    mutating: false,
    execute: async (input: { orderId: string }) => {
      const page = await getPage<Record<string, unknown>>(
        `orders/${encodeURIComponent(input.orderId)}/fulfillments.json`,
        {},
      );
      return page.items;
    },
  });

  registered = true;
}
