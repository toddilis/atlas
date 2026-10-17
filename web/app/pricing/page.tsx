// Pricing — the business's versioned price books, retailer agreements, shipping rules and
// terms (PRICING-01). The editor previews a draft with the same calculator invoices use;
// saving and activating go through the protected routes (lib/pricing-action.ts, 0033).

import { supabaseServer, orgId } from '@/lib/supabase';
import { formatDateTime } from '@/lib/format';
import { Badge, type BadgeTone } from '@/components/Badge';
import PricingEditor from '@/components/PricingEditor';
import {
  PRICING_OUTCOMES, firstVersionTemplate, formatInZone, nextVersionDraft, versionStatuses,
  type AccountOption, type ActivationRow, type ProductOption, type VersionRow, type VersionStatus,
} from '@/lib/pricing';

export const dynamic = 'force-dynamic';

const STATUS: Record<VersionStatus, { label: string; tone: BadgeTone }> = {
  active: { label: 'Active', tone: 'green' },
  scheduled: { label: 'Scheduled', tone: 'blue' },
  saved: { label: 'Saved, not active', tone: 'zinc' },
  superseded: { label: 'Superseded', tone: 'zinc' },
  expired: { label: 'Ended', tone: 'amber' },
};

async function loadPricing() {
  const sb = await supabaseServer();
  const org = orgId();
  const [versions, activations, products, accounts, grants, controls] = await Promise.all([
    sb.from('pricing_versions').select('id, revision, version_key, config, actor, reason, created_at').eq('org_id', org).order('revision', { ascending: false }),
    sb.from('pricing_activations').select('version_id, actor, reason, created_at').eq('org_id', org),
    sb.from('products').select('id, sku, display_name').eq('org_id', org).eq('active', true).order('display_name'),
    sb.from('accounts').select('id, name, tax_exempt').eq('org_id', org).order('name'),
    sb.from('tool_grants').select('tool_name, enabled').eq('org_id', org).eq('agent_name', 'operator').in('tool_name', ['pricing.save', 'pricing.activate']),
    sb.from('action_controls').select('paused').eq('org_id', org).maybeSingle(),
  ]);
  for (const r of [versions, activations, products, accounts, grants, controls]) if (r.error) throw r.error;
  const granted = (tool: string) => (grants.data ?? []).some(g => g.tool_name === tool && g.enabled);
  return {
    org,
    versions: (versions.data ?? []) as VersionRow[],
    activations: (activations.data ?? []) as ActivationRow[],
    products: (products.data ?? []).map(p => ({ id: p.id, sku: p.sku, name: p.display_name.trim() })) as ProductOption[],
    accounts: (accounts.data ?? []).map(a => ({ id: a.id, name: a.name, taxExempt: Boolean(a.tax_exempt) })) as AccountOption[],
    canSave: granted('pricing.save'), canActivate: granted('pricing.activate'), paused: Boolean(controls.data?.paused),
  };
}

export default async function PricingPage({ searchParams }: { searchParams: Promise<{ outcome?: string }> }) {
  const { outcome } = await searchParams;
  // Only the fixed success messages are shown from the URL; nothing from it is echoed.
  const notice = outcome === 'saved' || outcome === 'activated' ? PRICING_OUTCOMES[outcome] : null;
  const data = await loadPricing();
  const now = new Date();
  const statuses = versionStatuses(data.versions, data.activations, now);
  const latest = data.versions[0] ?? null;
  const active = data.versions.find(v => statuses.get(v.id) === 'active') ?? null;
  const activation = new Map(data.activations.map(a => [a.version_id, a]));
  const latestRevision = latest?.revision ?? 0;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Pricing</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Price books, retailer agreements, shipping and terms, as versions. A new version takes effect only when it is
          activated, from its &ldquo;effective from&rdquo; time; invoices already drafted keep their own snapshot.
        </p>
      </div>

      {notice && <p role="status" className="p-3 border rounded border-green-300 bg-green-50 text-green-900 text-sm">{notice}</p>}

      {data.paused && (
        <p role="status" className="p-3 border rounded border-amber-300 bg-amber-50 text-amber-900 text-sm">
          Business actions are paused. You can edit and preview, but saving and activating are refused until they resume.
        </p>
      )}

      <section aria-labelledby="active-heading" className="space-y-2">
        <h2 id="active-heading" className="text-lg font-medium">In effect now</h2>
        {active ? (
          <p className="text-sm">
            <strong>{active.config.name}</strong> ({active.version_key}, revision {active.revision}), effective from{' '}
            {formatInZone(active.config.effectiveFrom, active.config.timezone)}, activated by {activation.get(active.id)?.actor ?? 'unknown'}.
          </p>
        ) : (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            No pricing version is in effect. Invoice parts cannot be drafted until one is activated.
          </p>
        )}
      </section>

      <section aria-labelledby="history-heading" className="space-y-2">
        <h2 id="history-heading" className="text-lg font-medium">Versions</h2>
        {data.versions.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No versions saved yet. Create the first one below.</p>
        ) : (
          <table className="w-full text-sm text-left">
            <thead className="text-zinc-500"><tr>
              <th className="py-2 pr-3">Revision</th><th className="pr-3">Version</th><th className="pr-3">Effective from</th>
              <th className="pr-3">Saved</th><th className="pr-3">Reason</th><th>Status</th>
            </tr></thead>
            <tbody>
              {data.versions.map(v => {
                const status = STATUS[statuses.get(v.id) ?? 'saved'];
                const a = activation.get(v.id);
                return (
                  <tr key={v.id} className="border-t border-zinc-200 dark:border-zinc-800 align-top">
                    <td className="py-2 pr-3 tabular-nums">{v.revision}</td>
                    <td className="pr-3">{v.config.name} <span className="text-zinc-500">({v.version_key})</span></td>
                    <td className="pr-3">{formatInZone(v.config.effectiveFrom, v.config.timezone)}{v.config.effectiveUntil && <span className="block text-zinc-500">until {formatInZone(v.config.effectiveUntil, v.config.timezone)}</span>}</td>
                    <td className="pr-3">{formatDateTime(v.created_at)} by {v.actor}</td>
                    <td className="pr-3">{v.reason}{a && <span className="block text-zinc-500">Activated {formatDateTime(a.created_at)} by {a.actor}: {a.reason}</span>}</td>
                    <td><Badge tone={status.tone}>{status.label}</Badge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {data.products.length === 0 ? (
        <p role="status" className="p-3 border rounded text-sm">
          This business has no active products yet, so there is nothing to price. Products arrive with the Shopify catalogue sync.
        </p>
      ) : (
        <PricingEditor
          key={latest?.id ?? 'first'}
          initialConfig={latest ? nextVersionDraft(latest.config, latestRevision) : firstVersionTemplate(data.org, data.products)}
          activeConfig={active?.config ?? null}
          latest={latest ? { id: latest.id, revision: latest.revision, versionKey: latest.version_key, activated: activation.has(latest.id), config: latest.config } : null}
          expectedRevision={latestRevision}
          products={data.products}
          accounts={data.accounts}
          canSave={data.canSave && !data.paused}
          canActivate={data.canActivate && !data.paused}
        />
      )}
    </div>
  );
}
