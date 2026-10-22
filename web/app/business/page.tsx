// Business profile (0045, CONFIG-01c) — what printed invoices say about this business:
// legal name, tax number under the business's own label, address and payment
// instructions. Every field is optional; a missing value is simply not printed. The
// database enforces pause, the operator grant, bounds and stale edits.

import { supabaseServer, orgId } from '@/lib/supabase';
import { PROFILE_OUTCOMES, isProfileOutcome, type ProfileRow } from '@/lib/profile';

export const dynamic = 'force-dynamic';

async function loadProfile() {
  const sb = await supabaseServer();
  const org = orgId();
  const [orgRow, profile, grants, controls] = await Promise.all([
    sb.from('orgs').select('display_name').eq('id', org).single(),
    sb.from('business_profiles').select('legal_name, tax_label, tax_number, address, payment_instructions, updated_at').eq('org_id', org).maybeSingle(),
    sb.from('tool_grants').select('enabled').eq('org_id', org).eq('agent_name', 'operator').eq('tool_name', 'profile.save'),
    sb.from('action_controls').select('paused').eq('org_id', org).maybeSingle(),
  ]);
  for (const r of [orgRow, profile, grants, controls]) if (r.error) throw r.error;
  // Shown so the operator knows before trying; the database enforces both on every save.
  return {
    displayName: orgRow.data!.display_name,
    profile: (profile.data ?? null) as ProfileRow | null,
    can: (grants.data ?? []).some(g => g.enabled) && !controls.data?.paused,
  };
}

const field = 'rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm w-full';

export default async function BusinessPage({ searchParams }: { searchParams: Promise<{ outcome?: string }> }) {
  const { outcome } = await searchParams;
  const notice = isProfileOutcome(outcome) ? PROFILE_OUTCOMES[outcome] : null;
  const { displayName, profile, can } = await loadProfile();

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold">Business</h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          What printed invoices say about {displayName}. A blank field is simply not printed — nothing is invented.
        </p>
      </div>

      {notice ? (
        <div data-testid="profile-notice" role="status" className={`rounded-lg border p-4 text-sm ${notice.ok
          ? 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200'
          : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'}`}>
          {notice.text}
        </div>
      ) : null}

      {can ? (
        <form method="post" action="/business/save" className="space-y-4 rounded-lg border border-zinc-200 dark:border-zinc-800 p-5">
          <input type="hidden" name="expected_updated_at" value={profile?.updated_at ?? ''} />
          <label className="block text-sm">Legal name (printed as &ldquo;From&rdquo;; blank uses &ldquo;{displayName}&rdquo;)<br />
            <input name="legal_name" aria-label="Legal name" maxLength={200} defaultValue={profile?.legal_name ?? ''} className={field} /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">Tax number label<br />
              <input name="tax_label" aria-label="Tax number label" maxLength={40} placeholder="Tax number"
                defaultValue={profile?.tax_label ?? ''} className={field} /></label>
            <label className="block text-sm">Tax number<br />
              <input name="tax_number" aria-label="Tax number" maxLength={64} defaultValue={profile?.tax_number ?? ''} className={field} /></label>
          </div>
          <label className="block text-sm">Address (printed under the legal name)<br />
            <textarea name="address" aria-label="Business address" maxLength={500} rows={3}
              defaultValue={profile?.address ?? ''} className={field} /></label>
          <label className="block text-sm">Payment instructions (printed on every invoice — bank account and reference wording)<br />
            <textarea name="payment_instructions" aria-label="Payment instructions" maxLength={1000} rows={3}
              defaultValue={profile?.payment_instructions ?? ''} className={field} /></label>
          <button type="submit" className="rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 px-3 py-1 text-sm font-medium">
            Save profile
          </button>
        </form>
      ) : (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 text-sm text-zinc-600 dark:text-zinc-400">
          Profile editing is switched off (the operator profile.save grant is missing or revoked, or business actions are paused).
        </div>
      )}
    </div>
  );
}
