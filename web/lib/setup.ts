// Go-live checklist (docs/operations/GO_LIVE.md): what a business still has to set up before
// its first real invoice, read from its own stored rows. Pure: the /setup page loads a
// snapshot and this decides each step's state. Nothing here changes anything; every step
// says where the change is made.

import { sourceFreshness, type SyncSourceRow } from './today';

export type StepState = 'done' | 'todo' | 'warn' | 'optional';
export interface SetupStep { key: string; title: string; state: StepState; detail: string; href: string | null }

export interface GrantRow { agent_name: string; tool_name: string; enabled: boolean }
export interface SetupSnapshot {
  ledgerAccounts: number;
  grants: GrantRow[];
  paused: boolean;
  /** Newest finished job run, and jobs due for longer than WAITING_MINUTES that no worker picked up. */
  lastJobAt: string | null; waitingJobs: number;
  profile: { legal_name: string | null; payment_instructions: string | null } | null;
  retailers: number; products: number; pricingActive: boolean;
  shopify: SyncSourceRow | null; lastSyncAt: string | null;
  customers: { total: number; linked: number };
  bankAccounts: number; members: number;
  invoices: { issued: number; paid: number };
}

/** A job due this long ago and still unclaimed means no worker is taking it (the worker ticks every minute). */
export const WAITING_MINUTES = 10;

/** Switches a business turns on deliberately: never seeded when the API or worker starts. */
export const OFF_UNTIL_TURNED_ON = [
  { agent: 'operator', tool: 'controller.issue_invoice', risk: 'approve_required', dayOne: true, allows: 'Approve and issue an invoice part exactly as shown.' },
  { agent: 'operator', tool: 'payments.record', risk: 'notify', dayOne: true, allows: 'Record a payment against an invoice, by hand or from a matched bank receipt.' },
  { agent: 'operator', tool: 'members.save', risk: 'notify', dayOne: true, allows: 'Add or disable the people who may use this console.' },
  { agent: 'operator', tool: 'invoices.void', risk: 'notify', dayOne: false, allows: 'Void a wrongly issued invoice; its posting is reversed.' },
  { agent: 'operator', tool: 'carriers.record_manual_cost', risk: 'notify', dayOne: false, allows: 'Enter a freight cost by hand for a parcel GoSweetSpot cannot cost, such as a hand courier.' },
  { agent: 'operator', tool: 'assistant.ask', risk: 'notify', dayOne: false, allows: 'Ask the read-only assistant questions. Spends model credit; needs ANTHROPIC_API_KEY on the console.' },
  { agent: 'assistant', tool: 'assistant.narrate', risk: 'notify', dayOne: false, allows: 'Write the daily briefing on the home page. Spends model credit; needs ANTHROPIC_API_KEY on the worker.' },
] as const;

/** Switches the API and worker add for the business when they start (revocable, never re-enabled by a restart). */
export const SEEDED_AT_BOOT = [
  'jobs.retry', 'jobs.dismiss', 'pricing.save', 'pricing.activate', 'invoices.record_print', 'approvals.decide',
  'catalog.save', 'accounts.save', 'actions.pause', 'connections.save', 'statements.generate', 'profile.save',
  'statements.record_send', 'statements.void', 'bank_accounts.save', 'bank.import', 'bank.review',
  'reminders.generate', 'reminders.record_send', 'reminders.void',
] as const;

const grantOf = (grants: GrantRow[], agent: string, tool: string) => grants.find(g => g.agent_name === agent && g.tool_name === tool);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** SQL that turns one switch on for this business, to paste into the Supabase SQL editor. */
export function switchOnSql(orgId: string, agent: string, tool: string, risk: string): string {
  return `insert into tool_grants (org_id, agent_name, tool_name, risk, enabled)\n`
    + `values ('${orgId}', '${agent}', '${tool}', '${risk}', true)\n`
    + `on conflict (org_id, agent_name, tool_name) do update set enabled = true;`;
}

export function ago(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  return minutes < 1 ? 'under a minute ago' : minutes < 60 ? `${minutes} min ago`
    : minutes < 48 * 60 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1440)} days ago`;
}

export function switchRows(grants: GrantRow[]) {
  return OFF_UNTIL_TURNED_ON.map(w => ({ ...w, on: Boolean(grantOf(grants, w.agent, w.tool)?.enabled) }));
}

/** The deployment itself: what the runbook's deploy steps leave behind. */
export function deploymentSteps(s: SetupSnapshot, now: Date): SetupStep[] {
  const missing = SEEDED_AT_BOOT.filter(t => !grantOf(s.grants, 'operator', t));
  const revoked = SEEDED_AT_BOOT.filter(t => grantOf(s.grants, 'operator', t)?.enabled === false);
  const dayOneOff = switchRows(s.grants).filter(w => w.dayOne && !w.on).map(w => w.tool);
  return [
    s.ledgerAccounts > 0
      ? { key: 'chart', title: 'Chart of accounts', state: 'done', detail: `Seeded with ${plural(s.ledgerAccounts, 'account')}; issued invoices and payments post to it.`, href: '/ledger' }
      : { key: 'chart', title: 'Chart of accounts', state: 'todo', detail: 'Not seeded, so nothing can be issued or posted. Run select seed_chart_of_accounts(\'<business id>\'); once (runbook step 3).', href: null },
    missing.length === SEEDED_AT_BOOT.length
      ? { key: 'boot', title: 'API and worker started for this business', state: 'todo', detail: 'None of the standard switches exist yet: the API or worker has not started with ATLAS_ORG_ID set to this business (runbook step 4).', href: null }
      : missing.length > 0
        ? { key: 'boot', title: 'API and worker started for this business', state: 'warn', detail: `Missing ${missing.join(', ')}: deploy the current API and worker; they add missing switches when they start.`, href: null }
        : revoked.length > 0
          ? { key: 'boot', title: 'API and worker started for this business', state: 'warn', detail: `Started. Turned off for this business: ${revoked.join(', ')}. The console refuses those actions until they are turned back on.`, href: null }
          : { key: 'boot', title: 'API and worker started for this business', state: 'done', detail: `Started: all ${SEEDED_AT_BOOT.length} standard switches are on.`, href: null },
    dayOneOff.length === 0
      ? { key: 'switches', title: 'Day-one switches', state: 'done', detail: 'Issuing invoices, recording payments and managing members are on.', href: null }
      : { key: 'switches', title: 'Day-one switches', state: 'todo', detail: `Still off: ${dayOneOff.join(', ')}. Turn them on with the SQL in the switches table below (runbook step 6).`, href: null },
    workerStep(s, now),
    s.paused
      ? { key: 'pause', title: 'Business actions', state: 'warn', detail: 'Paused: nothing is issued, recorded, imported or synced until they are resumed on the home page.', href: '/' }
      : { key: 'pause', title: 'Business actions', state: 'done', detail: 'Running (not paused).', href: '/' },
  ];
}

function workerStep(s: SetupSnapshot, now: Date): SetupStep {
  const title = 'Background worker';
  if (s.paused) return { key: 'worker', title, state: 'warn', detail: 'Business actions are paused, so the worker picks up no jobs until they resume.', href: '/jobs' };
  if (s.waitingJobs > 0) return { key: 'worker', title, state: 'warn', href: '/jobs',
    detail: `${plural(s.waitingJobs, 'job has', 'jobs have')} been due for over ${WAITING_MINUTES} minutes without being picked up. Check the worker is running (fly logs) and has the settings those jobs need.` };
  if (s.lastJobAt) return { key: 'worker', title, state: 'done', href: '/jobs', detail: `Last job finished ${ago(s.lastJobAt, now)}; nothing is waiting to be picked up.` };
  if (s.shopify?.enabled) return { key: 'worker', title, state: 'warn', href: '/jobs', detail: 'No job has run yet although Shopify is connected. Check the worker is running with its SHOPIFY_* settings.' };
  return { key: 'worker', title, state: 'todo', href: '/jobs', detail: 'No job has run yet. The worker starts syncing once Shopify is connected.' };
}

/** The business's own setup, in the runbook's first-day order. */
export function businessSteps(s: SetupSnapshot, now: Date): SetupStep[] {
  const profileSaved = Boolean(s.profile?.legal_name?.trim());
  const instructions = Boolean(s.profile?.payment_instructions?.trim());
  return [
    !profileSaved
      ? { key: 'profile', title: 'Business profile', state: 'todo', detail: 'Legal name, tax number, address and payment instructions, printed on every invoice, statement and reminder.', href: '/business' }
      : instructions
        ? { key: 'profile', title: 'Business profile', state: 'done', detail: 'Saved; it prints on invoices, statements and reminders.', href: '/business' }
        : { key: 'profile', title: 'Business profile', state: 'warn', detail: 'Saved without payment instructions, so invoices and reminders will not say how to pay.', href: '/business' },
    s.retailers > 0 && s.products > 0
      ? { key: 'catalog', title: 'Retailers and products', state: 'done', detail: `${plural(s.retailers, 'retailer')} and ${plural(s.products, 'product')}.`, href: '/catalog' }
      : { key: 'catalog', title: 'Retailers and products', state: 'todo', detail: `${plural(s.retailers, 'retailer')} and ${plural(s.products, 'product')} so far. Product SKUs must match Shopify's.`, href: '/catalog' },
    s.pricingActive
      ? { key: 'pricing', title: 'Pricing', state: 'done', detail: 'A pricing version is active.', href: '/pricing' }
      : { key: 'pricing', title: 'Pricing', state: 'todo', detail: 'No active pricing version, so no shipment can be priced. Build one, preview a retailer, then activate it.', href: '/pricing' },
    shopifyStep(s, now),
    linkStep(s),
    s.bankAccounts > 0
      ? { key: 'bank', title: 'Bank accounts', state: 'done', detail: `${plural(s.bankAccounts, 'account')} to import statements into.`, href: '/bank' }
      : { key: 'bank', title: 'Bank accounts', state: 'optional', detail: 'Add them when you start importing statements; payments can be recorded by hand meanwhile.', href: '/bank' },
    s.members > 0
      ? { key: 'members', title: 'Members', state: 'done', detail: `${plural(s.members, 'member')}. Only members who are also on ATLAS_OPERATOR_EMAILS can sign in.`, href: '/members' }
      : { key: 'members', title: 'Members', state: 'todo', detail: 'No members yet, so anyone on ATLAS_OPERATOR_EMAILS can sign in. Add yourself first, then anyone else.', href: '/members' },
    s.invoices.paid > 0
      ? { key: 'first', title: 'First real invoice', state: 'done', detail: `${plural(s.invoices.issued, 'invoice')} issued, ${s.invoices.paid} with a payment recorded.`, href: '/invoices' }
      : s.invoices.issued > 0
        ? { key: 'first', title: 'First real invoice', state: 'todo', detail: `${plural(s.invoices.issued, 'invoice')} issued; none has a payment recorded yet. Record it when the money arrives.`, href: '/invoices' }
        : { key: 'first', title: 'First real invoice', state: 'todo', detail: 'Nothing issued yet. Once a wholesale shipment arrives, its invoice part is drafted on Invoices for you to approve and issue.', href: '/invoices' },
  ];
}

function shopifyStep(s: SetupSnapshot, now: Date): SetupStep {
  const title = 'Shopify connection';
  if (!s.shopify) return { key: 'shopify', title, state: 'todo', href: '/connections', detail: 'Not connected. Add the shop\'s myshopify.com domain, the same one as SHOPIFY_SHOP_DOMAIN.' };
  const name = s.shopify.connection_key;
  if (!s.shopify.enabled) return { key: 'shopify', title, state: 'warn', href: '/connections', detail: `${name} is turned off, so nothing syncs.` };
  const fresh = sourceFreshness(s.shopify, s.lastSyncAt, now);
  if (fresh.state === 'never') return { key: 'shopify', title, state: 'warn', href: '/jobs',
    detail: `${name} has never synced. Check the worker's SHOPIFY_* settings name this shop, then the Jobs page for the reason.` };
  if (fresh.state === 'stale') return { key: 'shopify', title, state: 'warn', href: '/jobs',
    detail: `${name} last synced ${ago(fresh.lastAt, now)}, later than its ${s.shopify.sync_every_minutes}-minute cadence allows. See the Jobs page.` };
  return { key: 'shopify', title, state: 'done', href: '/connections', detail: `${name}, last synced ${ago(fresh.lastAt, now)}.` };
}

function linkStep(s: SetupSnapshot): SetupStep {
  const title = 'Shopify customers linked to retailers';
  const { total, linked } = s.customers;
  if (total === 0) return { key: 'link', title, state: 'todo', href: null, detail: 'No Shopify customers have synced yet; they arrive with the first sync.' };
  if (linked === 0) return { key: 'link', title, state: 'todo', href: null,
    detail: `None of the ${plural(total, 'synced customer')} is linked to a retailer, so every shipment is treated as a retail order and nothing is invoiced. Link each retailer's Shopify customer before its first shipment (runbook step 8).` };
  const others = total - linked;
  return { key: 'link', title, state: 'done', href: null,
    detail: `${linked} of ${total} synced Shopify customers linked to retailers.`
      + (others > 0 ? ` Shipments for the other ${others} are treated as retail orders and not invoiced.` : '') };
}
