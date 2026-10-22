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
    // Console operators may retry or dismiss stopped background jobs (0030, 0031). Seeded
    // once; revoking a grant (enabled=false) switches that console action off.
    { agentName: 'operator', toolName: 'jobs.retry', risk: 'notify' },
    { agentName: 'operator', toolName: 'jobs.dismiss', risk: 'notify' },
    // Console operators may save and activate pricing versions (0033), on the same terms.
    { agentName: 'operator', toolName: 'pricing.save', risk: 'notify' },
    { agentName: 'operator', toolName: 'pricing.activate', risk: 'notify' },
    // Recording what happened to a printed invoice (0034). Issuing an invoice
    // (operator → controller.issue_invoice) is never seeded: a business turns it on.
    { agentName: 'operator', toolName: 'invoices.record_print', risk: 'notify' },
    // Console operators may decide pending approvals (0037), on the same terms as jobs.
    // The decision only AUTHORISES the stored action; execution still re-checks the
    // acting agent's own grant and policy.
    { agentName: 'operator', toolName: 'approvals.decide', risk: 'notify' },
    // Console operators may create and edit this business's products and retailers
    // (0040), on the same terms as pricing: setup, not money movement.
    { agentName: 'operator', toolName: 'catalog.save', risk: 'notify' },
    { agentName: 'operator', toolName: 'accounts.save', risk: 'notify' },
    // The emergency stop (0041): pause/resume all business actions from the console.
    // Seeded so a business never has to switch on its own kill switch; revoking the
    // grant removes the control.
    { agentName: 'operator', toolName: 'actions.pause', risk: 'notify' },
    // The Shopify connection (0042): connect, cadence, enable/disable in the console,
    // on the same terms as catalogue setup.
    { agentName: 'operator', toolName: 'connections.save', risk: 'notify' },
    // Statement generation (0044): a read-projection snapshot, the same class as
    // pricing edits. Recording payments stays never-seeded; this only derives.
    { agentName: 'operator', toolName: 'statements.generate', risk: 'notify' },
    // The business profile printed on documents (0045): setup, not money movement.
    { agentName: 'operator', toolName: 'profile.save', risk: 'notify' },
    // Statement lifecycle (0047): recording that a person sent the document, and
    // retiring a superseded snapshot — evidence on a read projection, the same class
    // as recording an invoice print. The sending itself stays with the human.
    { agentName: 'operator', toolName: 'statements.record_send', risk: 'notify' },
    { agentName: 'operator', toolName: 'statements.void', risk: 'notify' },
    // assistant.narrate (0038) is never seeded: it is the business's model-spend switch
    // for the daily briefing, turned on deliberately like controller.issue_invoice.
  ]);

  booted = true;
}
