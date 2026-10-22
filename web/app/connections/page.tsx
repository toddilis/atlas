// Connections (0042) — the business's Shopify connection, connected and maintained here
// (CONFIG-01b). One connection per business by design (0021; TENANT-01 remains open).
// The database enforces pause, the operator grant, the canonical domain, the fixed key,
// cadence bounds and stale edits; this page shows state and collects the change. The
// worker's API token stays a workspace setting — it is never stored or shown here.

import Link from 'next/link';
import { supabaseServer, orgId } from '@/lib/supabase';
import { CONNECTION_OUTCOMES, isConnectionOutcome, type ConnectionRow } from '@/lib/connections';

export const dynamic = 'force-dynamic';

async function loadConnection() {
  const sb = await supabaseServer();
  const org = orgId();
  const [source, grants, controls] = await Promise.all([
    sb.from('dispatch_sources').select('id, connection_key, enabled, sync_every_minutes, updated_at')
      .eq('org_id', org).eq('provider', 'shopify').maybeSingle(),
    sb.from('tool_grants').select('enabled').eq('org_id', org).eq('agent_name', 'operator').eq('tool_name', 'connections.save'),
    sb.from('action_controls').select('paused').eq('org_id', org).maybeSingle(),
  ]);
  for (const r of [source, grants, controls]) if (r.error) throw r.error;
  const connection = (source.data ?? null) as ConnectionRow | null;
  let sync: { state: string; last_error: string | null } | null = null;
  if (connection) {
    const job = await sb.from('scheduled_jobs').select('state, last_error')
      .eq('org_id', org).eq('kind', 'shopify_sync').eq('source_id', connection.id).maybeSingle();
    if (job.error) throw job.error;
    sync = job.data ?? null;
  }
  // Shown so the operator knows before trying; the database enforces pause and the
  // grant on every save.
  const paused = Boolean(controls.data?.paused);
  const granted = (grants.data ?? []).some(g => g.enabled);
  return {
    connection, sync,
    can: !paused && granted,
    note: paused ? 'Business actions are paused, so the connection cannot be changed until they are resumed.'
      : !granted ? 'Connection editing is switched off for this business (the operator connections.save grant is missing or revoked).' : null,
  };
}

const field = 'rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm';
const button = 'rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 px-3 py-1 text-sm font-medium';

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ outcome?: string }> }) {
  const { outcome } = await searchParams;
  const notice = isConnectionOutcome(outcome) ? CONNECTION_OUTCOMES[outcome] : null;
  const { connection, sync, can, note } = await loadConnection();

  return (
    <div className="space-y-8">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Connections</h1>
        <div className="text-sm text-zinc-500">{connection ? '1 Shopify connection' : 'No connection yet'}</div>
      </div>

      {notice ? (
        <div data-testid="connection-notice" role="status" className={`rounded-lg border p-4 text-sm ${notice.ok
          ? 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200'
          : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'}`}>
          {notice.text}
        </div>
      ) : null}

      {note ? (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 text-sm text-zinc-600 dark:text-zinc-400">{note}</div>
      ) : null}

      <section className="space-y-3" aria-label="Shopify">
        <h2 className="text-lg font-semibold">Shopify</h2>
        {connection ? (
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-5 space-y-4" data-testid="connection">
            <div className="text-sm">
              <span className="font-mono">{connection.connection_key}</span>
              <span className="ml-2 text-xs text-zinc-500">The shop domain is the connection&rsquo;s identity and cannot change; a different shop is a new connection.</span>
            </div>
            <div className="text-sm text-zinc-600 dark:text-zinc-400" data-testid="connection-sync">
              {sync === null ? 'No sync job yet; the worker arms one on its next pass while the connection is enabled.'
                : sync.state === 'blocked' && sync.last_error ? `Sync blocked: ${sync.last_error}` : `Sync job state: ${sync.state}.`}
              {' '}<Link href="/jobs" className="underline-offset-2 hover:underline">Jobs</Link>
            </div>
            {can ? (
              <form method="post" action="/connections/save" className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="source_id" value={connection.id} />
                <input type="hidden" name="expected_updated_at" value={connection.updated_at} />
                <label className="text-sm">Sync every (minutes)<br />
                  <input name="sync_every_minutes" aria-label="Sync cadence minutes" type="number" min={1} max={1440}
                    defaultValue={connection.sync_every_minutes} required className={`${field} w-24`} /></label>
                <label className="text-sm flex items-center gap-1 pb-1">
                  <input type="checkbox" name="enabled" defaultChecked={connection.enabled} /> Enabled
                </label>
                <button type="submit" className={button}>Save connection</button>
                {connection.enabled ? null : <span className="pb-1 text-xs text-amber-700 dark:text-amber-300">Disabled: nothing syncs and nothing new is projected from this shop.</span>}
              </form>
            ) : null}
            <div className="text-xs text-zinc-500">
              The worker syncs this shop only when its own SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_API_TOKEN settings match;
              the token is a workspace secret, never stored or shown here.
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-5 space-y-4">
            <div className="text-sm text-zinc-600 dark:text-zinc-400">
              No Shopify connection yet. Atlas supports one connection per business; orders, fulfillments, customers and
              products sync from it on the cadence below.
            </div>
            {can ? (
              <form method="post" action="/connections/save" className="flex flex-wrap items-end gap-2">
                <label className="text-sm">Shop domain<br />
                  <input name="connection_key" aria-label="Shop domain" placeholder="your-shop.myshopify.com" required maxLength={200}
                    className={`${field} w-72 font-mono`} /></label>
                <label className="text-sm">Sync every (minutes)<br />
                  <input name="sync_every_minutes" aria-label="Sync cadence minutes" type="number" min={1} max={1440}
                    defaultValue={15} required className={`${field} w-24`} /></label>
                <label className="text-sm flex items-center gap-1 pb-1">
                  <input type="checkbox" name="enabled" defaultChecked /> Enabled
                </label>
                <button type="submit" className={button}>Connect shop</button>
              </form>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
