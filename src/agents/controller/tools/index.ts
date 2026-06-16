// Controller agent tool registration. Mirrors src/integrations/shopify/tools.ts so
// src/api/server.ts can call a single bootstrap per domain.

import { registerTool } from '../../../platform/tools/registry.js';
import { buildPolicyInput, execute } from './issue_invoice.js';

let registered = false;

export function registerControllerTools(): void {
  if (registered) return;

  registerTool({
    name: 'controller.issue_invoice',
    defaultRisk: 'approve_required',
    mutating: true,
    policyInput: buildPolicyInput,
    execute,
  });

  registered = true;
}
