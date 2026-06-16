// Thin orchestrator dispatch — Phase 0 wires events directly into agent handlers via the
// projection dispatcher (see src/platform/events/projector.ts and registerAgent). A heavier
// scheduler + task router will land alongside Agent #2 when there are actually two agents to
// coordinate; speculating now is the failure mode the build plan calls out.
//
// What lives here in Phase 0: a single entry point the API + worker processes call at boot
// to register the in-process agents so their handlers receive events.

import { registerAgent } from '../agent/registry.js';
import { controllerAgent } from '../../agents/controller/index.js';
import { grantTools } from '../tools/grants.js';

let booted = false;

export async function bootAgents(): Promise<void> {
  if (booted) return;
  await registerAgent(controllerAgent);

  // Controller's Phase 0 tool grants. Read-only Shopify tools are auto-tier; mutating actions
  // (issue_invoice in Phase 1) are approve_required by policy.
  await grantTools([
    { agentName: 'controller', toolName: 'shopify.list_orders',     risk: 'auto' },
    { agentName: 'controller', toolName: 'shopify.list_customers',  risk: 'auto' },
    { agentName: 'controller', toolName: 'shopify.list_products',   risk: 'auto' },
    { agentName: 'controller', toolName: 'shopify.list_fulfillments', risk: 'auto' },
  ]);

  booted = true;
}
