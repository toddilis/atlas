// Business members (0049): who may operate THIS business, stored per business and
// enforced on every request on top of the deployment's environment allowlist —
// membership narrows access, never widens it. The database owns the lockout guards
// (first member is yourself; nobody disables themselves) and stale-edit rules.

import { supabaseServer, orgId } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth-server';
import { formatDate } from '@/lib/format';
import { Badge } from '@/components/Badge';
import { MEMBER_OUTCOMES, isMemberOutcome } from '@/lib/members';

export const dynamic = 'force-dynamic';

interface MemberRow {
  id: string;
  email: string;
  enabled: boolean;
  added_by: string;
  created_at: string;
  updated_at: string;
}

async function loadMembers(): Promise<{ rows: MemberRow[]; can: boolean; paused: boolean; self: string }> {
  const sb = await supabaseServer();
  const org = orgId();
  const operator = await requireOperator();
  const [rows, grants, controls] = await Promise.all([
    sb.from('org_members').select('id, email, enabled, added_by, created_at, updated_at').eq('org_id', org).order('created_at'),
    sb.from('tool_grants').select('enabled').eq('org_id', org).eq('agent_name', 'operator').eq('tool_name', 'members.save'),
    sb.from('action_controls').select('paused').eq('org_id', org).maybeSingle(),
  ]);
  for (const r of [rows, grants, controls]) if (r.error) throw r.error;
  const paused = Boolean(controls.data?.paused);
  return {
    rows: ((rows.data as unknown) as MemberRow[]) ?? [],
    can: (grants.data ?? []).some(g => g.enabled) && !paused,
    paused,
    self: operator.email.trim().toLowerCase(),
  };
}

const field = 'mt-1 block rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 text-sm';

export default async function MembersPage({ searchParams }: { searchParams: Promise<{ outcome?: string }> }) {
  const { outcome } = await searchParams;
  const notice = isMemberOutcome(outcome) ? MEMBER_OUTCOMES[outcome] : null;
  const { rows, can, paused, self } = await loadMembers();

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Members</h1>
        <div className="text-sm text-zinc-500">
          {rows.length} {rows.length === 1 ? 'member' : 'members'}
        </div>
      </div>
      <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-3xl">
        Who may operate this business. Membership is enforced on every request on top of the
        deployment&rsquo;s operator allowlist &mdash; it can narrow access, never widen it. A disabled
        member loses access on their next request.
      </p>

      {notice ? (
        <div data-testid="member-notice" role="status" className={`rounded-lg border p-4 text-sm ${notice.ok
          ? 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200'
          : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'}`}>
          {notice.text}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-4 text-sm text-amber-900 dark:text-amber-200">
          Bootstrap mode: this business has no members yet, so the environment allowlist alone
          admits operators. The first member you add must be yourself.
        </div>
      ) : null}

      {can ? (
        <form method="post" action="/members/save" className="flex flex-wrap items-end gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
          <input type="hidden" name="enabled" value="true" />
          <label className="text-sm">Email<br />
            <input name="email" aria-label="Member email" type="email" required maxLength={320} size={36}
              placeholder="operator@business.example" className={field} /></label>
          <button type="submit" className="rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 px-3 py-1 text-sm font-medium">
            Add member
          </button>
          <span className="pb-1 text-xs text-zinc-500">They must also be on the deployment allowlist to sign in.</span>
        </form>
      ) : (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 text-sm text-zinc-600 dark:text-zinc-400">
          Managing members is switched off (the operator members.save grant is {paused ? 'off or business actions are paused' : 'missing or revoked'}); a business turns it on deliberately.
        </div>
      )}

      {rows.length > 0 ? (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Email</th>
                <th className="text-left px-4 py-2 font-medium">State</th>
                <th className="text-left px-4 py-2 font-medium">Added</th>
                <th className="text-right px-4 py-2 font-medium">Change</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {rows.map((m) => (
                <tr key={m.id} data-testid="member-row">
                  <td className="px-4 py-2 font-mono">{m.email}{m.email === self ? <span className="ml-2 text-xs text-zinc-500">(you)</span> : null}</td>
                  <td className="px-4 py-2"><Badge tone={m.enabled ? 'green' : 'red'}>{m.enabled ? 'enabled' : 'disabled'}</Badge></td>
                  <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">{formatDate(m.created_at)} by {m.added_by}</td>
                  <td className="px-4 py-2 text-right">
                    {can ? (
                      <form method="post" action="/members/save" className="inline">
                        <input type="hidden" name="member_id" value={m.id} />
                        <input type="hidden" name="email" value={m.email} />
                        <input type="hidden" name="expected_updated_at" value={m.updated_at} />
                        <input type="hidden" name="enabled" value={m.enabled ? 'false' : 'true'} />
                        <button type="submit" aria-label={`${m.enabled ? 'Disable' : 'Enable'} ${m.email}`}
                          className={`rounded border px-3 py-1 text-sm font-medium ${m.enabled
                            ? 'border-red-300 dark:border-red-800 text-red-700 dark:text-red-400'
                            : 'border-zinc-300 dark:border-zinc-700'}`}>
                          {m.enabled ? 'Disable' : 'Enable'}
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
