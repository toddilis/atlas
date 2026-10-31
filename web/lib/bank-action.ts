// Console bank actions (0051): save a bank account, and import a statement file into one.
// The operator is verified here (session, allowlist, membership, same origin) and the
// file is parsed here; the database enforces pause, the bank_accounts.save and
// bank.import grants, the account's fixed identity, stale edits, every row again,
// exactly-once storage and the audit trail. The browser gets back fixed outcome codes.

import 'server-only';
import { createHash } from 'node:crypto';
import { OperatorAuthError, requireOperator } from './auth-server';
import { supabaseServer } from './supabase';
import {
  BANK_FILE_MAX_BYTES, bankResultQuery, importOutcomeFor, parseBankFile, saveOutcomeFor, statementFileName,
  type BankResult,
} from './bank-import';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Relative Location: request.url names Next's own hostname, not the browser's.
const back = (result: BankResult & { batch?: string; account?: string }) =>
  new Response(null, { status: 303, headers: { Location: `/bank?${bankResultQuery(result)}` } });

async function operatorOr(request: Request) {
  try { return { operator: await requireOperator(request) }; }
  catch (error) {
    if (!(error instanceof OperatorAuthError)) throw error;
    if (error.status === 401) return { refused: new Response(null, { status: 303, headers: { Location: '/login' } }) };
    return { refused: Response.json({ error: error.message }, { status: error.status }) };
  }
}

export async function saveBankAccountAction(request: Request) {
  const { operator, refused } = await operatorOr(request);
  if (!operator) return refused;
  const form = await request.formData();
  const text = (name: string, max: number) => { const v = form.get(name); return typeof v === 'string' && v.length <= max ? v.trim() : null; };
  const id = text('account_id', 36) ?? '';
  const expected = text('expected_updated_at', 40) ?? '';
  if (id !== '' && (!UUID.test(id) || expected === '' || Number.isNaN(Date.parse(expected)))) return back({ outcome: 'not_found' });
  const name = text('display_name', 100), bank = text('bank_name', 60), ref = text('account_ref', 40), currency = text('currency', 3);
  if (!name || (id === '' && (!bank || !ref || !currency || !/^[A-Za-z]{3}$/.test(currency)))) return back({ outcome: 'account_invalid' });

  const sb = await supabaseServer();
  const { error } = await sb.rpc('operator_save_bank_account', {
    p_org_id: operator.orgId,
    p_account_id: (id === '' ? null : id) as unknown as string,
    p_display_name: name,
    p_bank_name: id === '' ? bank : '', p_account_ref: id === '' ? ref : '', p_currency: id === '' ? currency : '',
    p_enabled: form.get('enabled') === 'on',
    p_expected_updated_at: (id === '' ? null : expected) as unknown as string,
    p_actor_id: operator.actorId, p_actor_email: operator.email,
  });
  if (!error) return back({ outcome: 'account_saved' });
  const outcome = saveOutcomeFor(error.message);
  if (outcome === 'failed') console.error('bank.account_save_failed', { error: error.message });
  return back({ outcome });
}

export async function importBankFileAction(request: Request) {
  const { operator, refused } = await operatorOr(request);
  if (!operator) return refused;
  const form = await request.formData();
  const accountId = form.get('bank_account_id');
  if (typeof accountId !== 'string' || !UUID.test(accountId)) return back({ outcome: 'not_found' });
  const file = form.get('file');
  if (file === null || typeof file === 'string' || file.size === 0) return back({ outcome: 'file_missing', account: accountId });
  if (file.size > BANK_FILE_MAX_BYTES) return back({ outcome: 'file_too_large', account: accountId });
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return back({ outcome: 'file_invalid', why: 'encoding', account: accountId }); }

  const sb = await supabaseServer();
  // The account's own currency checks each row here; the database checks it again.
  const account = await sb.from('bank_accounts').select('id, currency, enabled')
    .eq('org_id', operator.orgId).eq('id', accountId).maybeSingle();
  if (account.error) throw account.error;
  if (!account.data) return back({ outcome: 'not_found' });
  if (!account.data.enabled) return back({ outcome: 'account_disabled', account: accountId });
  const parsed = parseBankFile(text, String(account.data.currency), new Date().toISOString().slice(0, 10));
  if (!parsed.ok) return back({ outcome: 'file_invalid', why: parsed.why, row: parsed.row, column: parsed.column, account: accountId });

  const { data, error } = await sb.rpc('operator_import_bank_lines', {
    p_org_id: operator.orgId, p_bank_account_id: accountId, p_file_name: statementFileName(file.name),
    p_file_sha256: createHash('sha256').update(bytes).digest('hex'), p_lines: parsed.lines,
    p_actor_id: operator.actorId, p_actor_email: operator.email,
  });
  if (error) {
    const result = importOutcomeFor(error.message);
    if (result.outcome === 'failed') console.error('bank.import_failed', { bank_account_id: accountId, error: error.message });
    return back({ ...result, account: accountId });
  }
  const stored = (data as Array<{ oib_batch_id: string; oib_was_existing: boolean }>)[0];
  return back({ outcome: stored.oib_was_existing ? 'already_imported' : 'imported', batch: stored.oib_batch_id, account: accountId });
}
