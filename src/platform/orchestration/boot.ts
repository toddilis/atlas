// Shared platform boot — one registration path for every process (API, worker), so the
// two can't drift. Order matters: tools before projectors before agents (agent
// registration wires triggers into the projector dispatcher and upserts tool grants).

import { registerShopifyTools } from '../../integrations/shopify/tools.js';
import { registerStripeTools } from '../../integrations/stripe/tools.js';
import { registerControllerTools } from '../../agents/controller/tools/index.js';
import { registerShopifyProjectors } from '../../integrations/shopify/webhook.js';
import { registerStripeProjectors } from '../../integrations/stripe/webhook.js';
import { bootAgents } from './dispatch.js';

let booted = false;

export async function bootPlatform(): Promise<void> {
  if (booted) return;
  registerShopifyTools();
  registerStripeTools();
  registerControllerTools();
  registerShopifyProjectors();
  registerStripeProjectors();
  await bootAgents();
  booted = true;
}
