// Controller agent tool registration. Mirrors src/integrations/shopify/tools.ts so
// src/api/server.ts can call a single bootstrap per domain.

import { registerTool } from '../../../platform/tools/registry.js';
import { buildPolicyInput, execute as executeIssueInvoice } from './issue_invoice.js';
import { execute as executeDraftInvoice } from './draft_invoice.js';
import { execute as executeGenerateStatement } from './generate_statement.js';

let registered = false;

export function registerControllerTools(): void {
  if (registered) return;

  registerTool({
    name: 'controller.issue_invoice',
    defaultRisk: 'approve_required',
    mutating: true,
    policyInput: buildPolicyInput,
    execute: executeIssueInvoice,
  });

  // draft_invoice is the deterministic projection of a wholesale fulfillment into an
  // invoice row + lines. No money moves; no policy gate. The controller's onEvent calls
  // execute() directly (same precedent as the outbox drainer); the registry registration
  // is for a future LLM-loop entry point.
  registerTool({
    name: 'controller.draft_invoice',
    defaultRisk: 'auto',
    mutating: true,
    execute: executeDraftInvoice,
  });

  // generate_statement is a snapshot-and-insert. No money moves; the policy gate is
  // unnecessary. Sending the statement to the customer is a separate later tool with
  // its own gate.
  registerTool({
    name: 'controller.generate_statement',
    defaultRisk: 'auto',
    mutating: true,
    execute: executeGenerateStatement,
  });

  registered = true;
}
