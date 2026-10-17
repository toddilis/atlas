// One invoice part pass (step 4c) for a business, in its own process as on each worker
// tick, printing the pass result as JSON on the last line. The console's browser
// acceptance runs it against the disposable stack; the console never imports worker code.
//
// Usage: SUPABASE_URL=http://127.0.0.1:… SUPABASE_SERVICE_ROLE_KEY=… tsx scripts/invoice-part-pass.ts <org id>

import { runInvoicePartJobs } from '../src/agents/controller/invoice-parts.js';

const org = process.argv[2];
if (!org) { console.error('usage: tsx scripts/invoice-part-pass.ts <org id>'); process.exit(2); }
// It drafts invoices with the service key, so only against a local disposable stack.
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.SUPABASE_URL ?? '')) {
  console.error('refusing: SUPABASE_URL must be a local disposable stack');
  process.exit(2);
}
console.log(JSON.stringify(await runInvoicePartJobs(org)));
