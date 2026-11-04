// Go-live checklist (docs/operations/GO_LIVE.md): what this business still needs before its
// first real invoice, read from its own stored rows on every load. Read-only: each step
// links to the page that makes the change, and switches that have no console control yet
// show the exact SQL to paste into the Supabase SQL editor.

import Link from 'next/link';
import { supabaseServer, orgId } from '@/lib/supabase';
import type { SyncSourceRow } from '@/lib/today';
import {
  businessSteps, deploymentSteps, switchOnSql, switchRows, WAITING_MINUTES, type GrantRow, type SetupSnapshot, type SetupStep, type StepState,
} from '@/lib/setup';

export const dynamic = 'force-dynamic';

async function loadSetup(now: Date): Promise<SetupSnapshot> {
  const sb = await supabaseServer();
  const org = orgId();
  const count = { count: 'exact', head: true } as const;
  const waitingSince = new Date(now.getTime() - WAITING_MINUTES * 60_000).toISOString();
  const [ledger, grants, controls, lastRun, waiting, profile, retailers, products, activations, sources, customers, linked,
    bank, members, issued, paid] = await Promise.all([
    sb.from('ledger_accounts').select('id', count).eq('org_id', org),
    sb.from('tool_grants').select('agent_name, tool_name, enabled').eq('org_id', org).limit(1000),
    sb.from('action_controls').select('paused').eq('org_id', org).maybeSingle(),
    sb.from('job_runs').select('finished_at').eq('org_id', org).order('finished_at', { ascending: false }).limit(1),
    sb.from('scheduled_jobs').select('job_key', count).eq('org_id', org).in('state', ['pending', 'failed', 'blocked']).lt('next_attempt_at', waitingSince),
    sb.from('business_profiles').select('legal_name, payment_instructions').eq('org_id', org).maybeSingle(),
    sb.from('accounts').select('id', count).eq('org_id', org),
    sb.from('products').select('id', count).eq('org_id', org),
    sb.from('pricing_activations').select('id', count).eq('org_id', org),
    sb.from('dispatch_sources').select('id, connection_key, enabled, sync_every_minutes').eq('org_id', org).eq('provider', 'shopify'),
    sb.from('shopify_customers').select('id', count).eq('org_id', org),
    sb.from('shopify_customers').select('id', count).eq('org_id', org).not('account_id', 'is', null),
    sb.from('bank_accounts').select('id', count).eq('org_id', org).eq('enabled', true),
    sb.from('org_members').select('id', count).eq('org_id', org).eq('enabled', true),
    sb.from('invoices').select('id', count).eq('org_id', org).in('state', ['issued', 'partial', 'paid', 'overdue']),
    sb.from('invoices').select('id', count).eq('org_id', org).in('state', ['partial', 'paid']),
  ]);
  for (const r of [ledger, grants, controls, lastRun, waiting, profile, retailers, products, activations, sources, customers, linked,
    bank, members, issued, paid]) if (r.error) throw r.error;
  const shopify = ((sources.data ?? []) as SyncSourceRow[])[0] ?? null;
  // The newest successful sync of this connection, if it has one.
  const sync = shopify
    ? await sb.from('job_runs').select('finished_at').eq('org_id', org).eq('job_key', `shopify-sync:${shopify.id}`).eq('outcome', 'succeeded')
      .order('finished_at', { ascending: false }).limit(1)
    : null;
  if (sync?.error) throw sync.error;
  return {
    ledgerAccounts: ledger.count ?? 0,
    grants: (grants.data ?? []) as GrantRow[],
    paused: Boolean(controls.data?.paused),
    lastJobAt: (lastRun.data ?? [])[0]?.finished_at ?? null,
    waitingJobs: waiting.count ?? 0,
    profile: profile.data ?? null,
    retailers: retailers.count ?? 0, products: products.count ?? 0, pricingActive: (activations.count ?? 0) > 0,
    shopify, lastSyncAt: (sync?.data ?? [])[0]?.finished_at ?? null,
    customers: { total: customers.count ?? 0, linked: linked.count ?? 0 },
    bankAccounts: bank.count ?? 0, members: members.count ?? 0,
    invoices: { issued: issued.count ?? 0, paid: paid.count ?? 0 },
  };
}

const BADGE: Record<StepState, { label: string; className: string }> = {
  done: { label: 'Done', className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' },
  todo: { label: 'To do', className: 'bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200' },
  warn: { label: 'Check', className: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300' },
  optional: { label: 'Optional', className: 'border border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400' },
};

function Steps({ label, steps }: { label: string; steps: SetupStep[] }) {
  return (
    <section className="space-y-3" aria-label={label}>
      <h2 className="text-lg font-semibold">{label}</h2>
      <ol className="divide-y divide-zinc-100 dark:divide-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800">
        {steps.map(step => (
          <li key={step.key} data-testid={`setup-step-${step.key}`} data-state={step.state} className="flex gap-4 p-3 text-sm">
            <span className={`h-fit w-16 shrink-0 whitespace-nowrap rounded px-2 py-0.5 text-center text-xs font-medium ${BADGE[step.state].className}`}>{BADGE[step.state].label}</span>
            <div className="flex-1 space-y-1">
              <div className="font-medium">{step.title}</div>
              <div className="text-zinc-600 dark:text-zinc-400">{step.detail}</div>
            </div>
            {step.href ? <Link href={step.href} className="h-fit whitespace-nowrap text-zinc-500 underline-offset-2 hover:underline">Open</Link> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

export default async function SetupPage() {
  const now = new Date();
  const org = orgId();
  const snapshot = await loadSetup(now);
  const switches = switchRows(snapshot.grants);
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Go-live checklist</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-3xl">
          Read from this business&rsquo;s stored records each time the page loads. Nothing here changes anything: each step
          opens the page that does, and the runbook (docs/operations/GO_LIVE.md) has the full steps, in order.
        </p>
        <p className="text-sm text-zinc-500">Business id <code className="font-mono" data-testid="setup-org-id">{org}</code></p>
      </div>
      <Steps label="Deployment" steps={deploymentSteps(snapshot, now)} />
      <Steps label="Business setup" steps={businessSteps(snapshot, now)} />
      <section className="space-y-3" aria-label="Switches">
        <h2 className="text-lg font-semibold">Switches you turn on</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-3xl">
          These are never turned on automatically, so each business decides. There is no console control for them yet: paste
          the SQL into the Supabase SQL editor, then reload this page. To turn one off again, set <code>enabled = false</code> on
          its row.
        </p>
        <table className="w-full text-sm">
          <thead className="text-left text-zinc-500">
            <tr><th className="py-1">Switch</th><th>Allows</th><th>Day one</th><th>State</th></tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {switches.map(w => (
              <tr key={`${w.agent}:${w.tool}`} data-testid={`switch-${w.tool}`} className="align-top">
                <td className="py-2 pr-4 font-mono whitespace-nowrap">{w.tool}</td>
                <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                  {w.allows}
                  {w.on ? null : (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-zinc-500">SQL to turn on</summary>
                      <pre className="mt-1 whitespace-pre-wrap rounded bg-zinc-50 dark:bg-zinc-900 p-2 font-mono text-xs">{switchOnSql(org, w.agent, w.tool, w.risk)}</pre>
                    </details>
                  )}
                </td>
                <td className="py-2 pr-4">{w.dayOne ? 'Yes' : 'When needed'}</td>
                <td className={`py-2 font-medium ${w.on ? 'text-emerald-700 dark:text-emerald-400' : 'text-zinc-500'}`}>{w.on ? 'On' : 'Off'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
