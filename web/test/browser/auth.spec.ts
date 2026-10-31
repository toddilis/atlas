import { test, expect, type Page } from '@playwright/test';
import { calculatePricing } from '../../../src/platform/pricing/versioned';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const authUrl = 'http://127.0.0.1:54321/auth/v1';
const password = 'disposable-atlas-browser-password';
async function login(page: Page, email = 'operator@example.test') {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
test.beforeAll(async ({ request }) => {
  for (const email of ['operator@example.test', 'denied@example.test', 'second@example.test']) {
    const response = await request.post(`${authUrl}/admin/users`, {
      headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
      data: { email, password, email_confirm: true },
    });
    // Idempotent: a failed test restarts the worker and re-runs this hook, so an
    // already-registered user is fine — anything else would fail every later journey.
    const body = await response.text();
    expect(response.ok() || body.includes('already been registered'), body).toBeTruthy();
  }
});

test('anonymous browser and direct API cannot read protected identity', async ({ page, request }) => {
  await page.goto('/invoices');
  await expect(page).toHaveURL(/\/login$/);
  const response = await request.get('/api/session');
  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({ error: 'Sign in required.' });
});

test('permitted real auth session reaches console and trusted server identity; signout clears access', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  const response = await page.request.get('/api/session?orgId=attacker&actorId=attacker');
  expect(response.status()).toBe(200);
  const identity = await response.json();
  expect(identity.email).toBe('operator@example.test');
  expect(identity.orgId).toBe(process.env.ATLAS_ORG_ID);
  expect(identity.actorId).toMatch(/^[a-f0-9-]{36}$/);
  await page.goto('/invoices');
  await expect(page.getByText('AUTH-ALLOWED-001')).toBeVisible();
  await expect(page.getByText('AUTH-OTHER-SECRET-001')).toHaveCount(0);
  const crossSite = await page.request.post('/auth/signout', { headers: { Origin: 'https://attacker.invalid' } });
  expect(crossSite.status()).toBe(403);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get('/api/session')).status()).toBe(401);
});

test('valid non-allowlisted account is denied and its cookies are cleared', async ({ page }) => {
  await login(page, 'denied@example.test');
  await expect(page.getByText('This account is not on the operator allowlist.')).toBeVisible();
  expect((await page.request.get('/api/session')).status()).toBe(401);
  await page.goto('/invoices');
  await expect(page).toHaveURL(/\/login$/);
});

test('direct API rejects a real non-allowlisted session with 403', async ({ page, request }) => {
  const login = await request.post(`${authUrl}/token?grant_type=password`, {
    data: { email: 'denied@example.test', password },
  });
  expect(login.ok()).toBeTruthy();
  const session = await login.json();
  await page.context().addCookies([{
    name: 'sb-127-auth-token',
    value: `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`,
    domain: '127.0.0.1', path: '/', sameSite: 'Lax',
  }]);
  const response = await page.request.get('/api/session');
  expect(response.status()).toBe(403);
  expect(await response.json()).toEqual({ error: 'Operator access denied.' });
});

test('genuinely expired access token with revoked refresh session cannot regain access', async ({ page, request }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  const cookies = await page.context().cookies();
  const sessionCookie = cookies.filter(c => /sb-.*-auth-token(?:\.\d+)?$/.test(c.name)).sort((a,b) => a.name.localeCompare(b.name)).map(c => c.value).join('');
  expect(sessionCookie.startsWith('base64-')).toBeTruthy();
  const session = JSON.parse(Buffer.from(sessionCookie.slice(7), 'base64url').toString());
  const logout = await request.post(`${authUrl}/logout?scope=global`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  expect(logout.ok()).toBeTruthy();
  // Home has no mounted auth client, so no background browser refresh. Wait for
  // GoTrue's actual issued JWT expiry; no clock mocks or fabricated expired JWT.
  const exp = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64url').toString()).exp;
  await new Promise(resolve => setTimeout(resolve, Math.max(0, exp * 1000 - Date.now() + 1500)));
  expect((await page.request.get('/api/session')).status()).toBe(401);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
});

test('the home page is the operator\'s day, from stored rows alone, with explicit empty and never-synced states', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();

  // The day's narration is shown with its cited record; figures stay the dashboard's.
  const briefing = page.getByTestId('today-briefing');
  await expect(briefing).toContainText('Two proposals wait for a decision and one connection has never synced.');
  await expect(briefing.getByRole('link', { name: 'pending approval: demo.widget_restock' })).toHaveAttribute('href', '/approvals');
  await expect(briefing).toContainText('every figure on this page comes from the records');

  await expect(page.getByTestId('stat-approvals')).toContainText('Pending approvals');
  await expect(page.getByTestId('stat-approvals')).toContainText('2');
  await expect(page.getByTestId('stat-jobs')).toContainText('3 blocked · 1 quarantined');
  await expect(page.getByTestId('stat-parts')).toContainText('0');
  await expect(page.getByTestId('today-next-sync')).toContainText('Next Shopify sync in');

  // Freshness names this business's connection only, and says plainly it never synced.
  const freshness = page.getByTestId('today-freshness');
  await expect(freshness).toContainText('jobs-1111.myshopify.com');
  await expect(freshness).toContainText('No successful sync yet.');
  await expect(page.getByText('jobs-2222')).toHaveCount(0);

  await expect(page.getByTestId('today-receivables')).toContainText('Nothing issued is outstanding.');
  await page.screenshot({ path: 'test-results/today.png', fullPage: true });
});

test('operator sees blocked and quarantined jobs with their reason, and no other business\'s jobs', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  await page.getByRole('link', { name: 'Jobs', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Background jobs' })).toBeVisible();
  await expect(page.getByTestId('last-run')).toContainText(/Last worker run \d+m ago/);
  // The seeded pending job has been due for 30 minutes with no worker running.
  await expect(page.getByTestId('overdue')).toContainText('1 job is overdue by more than 10 minutes');

  const attention = page.getByRole('region', { name: 'Needs a person' }).getByTestId('job');
  await expect(attention).toHaveCount(4);
  const quarantined = attention.nth(0);
  await expect(quarantined).toContainText('quarantined');
  await expect(quarantined).toContainText('Order #1002');
  await expect(quarantined).toContainText('TRK-QUARANTINED');
  await expect(quarantined).toContainText('Stopped after 8 attempts. Atlas will not retry it on its own.');
  await expect(quarantined).toContainText('Check the shipment was booked in GoSweetSpot under that tracking number.');
  const blocked = attention.nth(1);
  await expect(blocked).toContainText('GOSWEETSPOT_SITE_ID must be set');
  await expect(blocked).toContainText('Set this GoSweetSpot setting on the worker host.');
  await expect(blocked).toContainText(/Next attempt in 4 h \d+ min \(attempt 3 of 8\)/);
  await blocked.getByText('Attempt history (2)').click();
  await expect(blocked).toContainText('HTTP 502');
  // The connection's own sync job (0036): no dispatch, named by the connection.
  const sync = attention.filter({ hasText: 'Shopify sync' });
  await expect(sync).toHaveCount(1);
  await expect(sync).toContainText('The business\'s Shopify connection');
  await expect(sync).toContainText('SHOPIFY_ADMIN_API_TOKEN must be set');
  await expect(sync).toContainText('Set this Shopify setting on the worker host.');

  const retrying = page.getByRole('region', { name: 'Retrying' }).getByTestId('job');
  await expect(retrying).toHaveCount(1);
  await expect(retrying).toContainText('HTTP 503');
  await expect(page.getByRole('region', { name: 'Queued and running' }).getByTestId('job')).toHaveCount(1);
  await expect(page.getByText('OTHER-BUSINESS-SECRET-ERROR')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/jobs.png', fullPage: true });
});

test('operator decides pending approvals with a reason; decisions and execution state are shown', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  await page.getByRole('link', { name: 'Approvals', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Approvals', exact: true })).toBeVisible();

  const pending = page.getByRole('region', { name: 'Pending approvals' }).getByTestId('approval');
  await expect(pending).toHaveCount(2);
  await expect(page.getByText('OTHER-APPROVAL-SECRET')).toHaveCount(0);

  // Approve the restock with a reason: the decision and who made it are recorded, and the
  // card explains that the worker executes it.
  const restock = pending.filter({ hasText: 'Restock widget order #88' });
  await restock.getByLabel('Reason').fill('stock confirmed with the warehouse');
  await restock.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByTestId('approval-notice')).toContainText('Approved. The worker executes it on its next pass');
  const decided = page.getByRole('region', { name: 'Recently decided' }).getByTestId('approval');
  const approved = decided.filter({ hasText: 'Restock widget order #88' });
  await expect(approved).toContainText('Approved by operator@example.test');
  await expect(approved).toContainText('stock confirmed with the warehouse');
  await expect(approved.getByTestId('execution-status')).toContainText('The worker executes it on its next pass');

  // Reject the other: final, with nothing to execute.
  const credit = page.getByRole('region', { name: 'Pending approvals' }).getByTestId('approval').filter({ hasText: 'Credit note for order #91' });
  await credit.getByLabel('Reason').fill('not our retailer');
  await credit.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByTestId('approval-notice')).toContainText('Rejected. Nothing will be executed');
  await expect(page.getByRole('region', { name: 'Pending approvals' }).getByTestId('approval')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Recently decided' }).getByTestId('approval').filter({ hasText: 'Credit note for order #91' }))
    .toContainText('Rejected by operator@example.test');
  await page.screenshot({ path: 'test-results/approvals.png', fullPage: true });
});

test('the assistant shows recorded exchanges with their real citations, and says plainly when no model is configured', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  await page.getByRole('link', { name: 'Assistant', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Assistant', exact: true })).toBeVisible();

  // CI's console holds no model key: the page says so instead of offering a dead form.
  await expect(page.getByTestId('assistant-note')).toContainText('No model is configured on the console host');
  await expect(page.getByRole('button', { name: 'Ask' })).toHaveCount(0);

  const exchange = page.getByTestId('exchange').filter({ hasText: 'Which invoices are overdue?' });
  await expect(exchange).toContainText('One invoice is outstanding and none are overdue.');
  await expect(exchange).toContainText('operator@example.test');
  await expect(exchange).toContainText('invoices_lookup');
  await expect(exchange.getByRole('link', { name: 'invoice AUTH-ALLOWED-001 (draft)' }))
    .toHaveAttribute('href', '/invoices/00000000-0000-4000-8000-00000000bbbb');
  await page.screenshot({ path: 'test-results/assistant.png', fullPage: true });
});

test('operator retries a stopped job with a reason; a stale page cannot retry it again', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  await page.goto('/jobs');
  const quarantined = page.getByRole('region', { name: 'Needs a person' }).getByTestId('job').filter({ hasText: 'TRK-QUARANTINED' });
  await expect(quarantined).toContainText('quarantined');
  // The form as loaded, kept to replay later as a stale page would.
  const stale = {
    job_key: await quarantined.locator('input[name=job_key]').inputValue(),
    expected_updated_at: await quarantined.locator('input[name=expected_updated_at]').inputValue(),
    reason: 'second click from an old tab',
  };
  await quarantined.getByRole('button', { name: 'Retry now' }).click();
  await expect(page).toHaveURL(/\/jobs$/); // the browser refuses an empty reason before posting
  await quarantined.getByLabel('Reason', { exact: true }).fill('Booked the missing consignment in GoSweetSpot');
  await quarantined.getByRole('button', { name: 'Retry now' }).click();
  await expect(page).toHaveURL(/\/jobs\?outcome=retried$/);
  await expect(page.getByTestId('action-notice')).toContainText('Job queued.');
  await expect(page.getByRole('region', { name: 'Needs a person' }).getByText('TRK-QUARANTINED')).toHaveCount(0);
  const queued = page.getByRole('region', { name: 'Queued and running' }).getByTestId('job').filter({ hasText: 'TRK-QUARANTINED' });
  await expect(queued).toContainText('pending');
  await expect(queued).toContainText('Not tried yet');

  // Replaying the old form is refused by the database and says so; nothing changes.
  await page.goto('/jobs');
  await page.evaluate((fields) => {
    const form = document.createElement('form');
    form.method = 'post'; form.action = '/jobs/retry';
    for (const [name, value] of Object.entries(fields)) {
      const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; form.appendChild(input);
    }
    document.body.appendChild(form); form.submit();
  }, stale);
  await expect(page).toHaveURL(/\/jobs\?outcome=changed$/);
  await expect(page.getByTestId('action-notice')).toContainText('This job changed after the page loaded. Nothing changed');

  // Another site cannot post the action with the operator's cookies.
  const crossSite = await page.request.post('/jobs/retry', { headers: { Origin: 'https://attacker.invalid' }, form: stale });
  expect(crossSite.status()).toBe(403);
  await page.screenshot({ path: 'test-results/jobs-retried.png', fullPage: true });
});

test('operator dismisses a job that will never succeed, and undoes it by retrying', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  await page.goto('/jobs');
  const blocked = page.getByRole('region', { name: 'Needs a person' }).getByTestId('job').filter({ hasText: 'TRK-BLOCKED' });
  await blocked.getByLabel('Reason', { exact: true }).fill('Parcel went by hand courier, not GoSweetSpot');
  await blocked.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page).toHaveURL(/\/jobs\?outcome=dismissed$/);
  await expect(page.getByTestId('action-notice')).toContainText('Job dismissed. Atlas will not retry it.');
  await expect(page.getByRole('region', { name: 'Needs a person' }).getByText('TRK-BLOCKED')).toHaveCount(0);
  const dismissed = page.getByRole('region', { name: 'Dismissed' }).getByTestId('job').filter({ hasText: 'TRK-BLOCKED' });
  await expect(dismissed).toContainText('dismissed');
  await expect(dismissed).toContainText('cannot be drafted until a cost is recorded');
  await expect(dismissed.getByRole('button', { name: 'Dismiss' })).toHaveCount(0);
  await dismissed.getByText(/Attempt history/).click();
  await expect(dismissed).toContainText('dismissed by operator');
  await expect(dismissed).toContainText('operator@example.test: Parcel went by hand courier, not GoSweetSpot');
  await page.screenshot({ path: 'test-results/jobs-dismissed.png', fullPage: true });

  await dismissed.getByLabel('Reason', { exact: true }).fill('It was booked in GoSweetSpot after all');
  await dismissed.getByRole('button', { name: 'Retry now' }).click();
  await expect(page).toHaveURL(/\/jobs\?outcome=retried$/);
  await expect(page.getByRole('region', { name: 'Dismissed' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Queued and running' }).getByTestId('job').filter({ hasText: 'TRK-BLOCKED' })).toContainText('Not tried yet');
});

test('operator records a hand-courier cost for a dismissed job, attributed to them', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  await page.goto('/jobs');
  const job = page.getByRole('region', { name: 'Needs a person' }).getByTestId('job').filter({ hasText: 'TRK-COURIER' });
  await job.getByLabel('Reason', { exact: true }).fill('Sent by hand courier, not GoSweetSpot');
  await job.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page).toHaveURL(/\/jobs\?outcome=dismissed$/);

  const dismissed = page.getByRole('region', { name: 'Dismissed' }).getByTestId('job').filter({ hasText: 'TRK-COURIER' });
  const form = dismissed.getByTestId('manual-cost');
  await expect(form).toContainText('Carrier cost (NZD, excl. tax)');
  await form.getByLabel('Carrier cost (NZD, excl. tax)').fill('12.345');
  await form.getByLabel('Why by hand').fill('Hand courier across town');
  await form.getByRole('button', { name: 'Record carrier cost' }).click();
  await expect(page).toHaveURL(/\/jobs\?outcome=dismissed$/); // the browser refuses three decimals before posting
  await form.getByLabel('Carrier cost (NZD, excl. tax)').fill('18.40');
  await form.getByLabel('Reference (optional)').fill('COURIER-RCPT-0042');
  await form.getByRole('button', { name: 'Record carrier cost' }).click();
  await expect(page).toHaveURL(/\/jobs\?outcome=cost_recorded$/);
  await expect(page.getByTestId('action-notice')).toContainText('Carrier cost recorded and attributed to you.');
  await expect(page.getByRole('region', { name: 'Dismissed' })).toHaveCount(0);
  await expect(page.getByText('TRK-COURIER')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/jobs-cost-recorded.png', fullPage: true });
});

test('operator builds the first pricing version, previews a retailer, saves and activates it', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  await page.goto('/pricing');
  await expect(page.getByRole('region', { name: 'In effect now' })).toContainText('No pricing version is in effect');
  await expect(page.getByText(/OTHER-SECRET/)).toHaveCount(0);
  // Nothing is priced until every money choice is made: the draft cannot be saved yet.
  await expect(page.getByText('Not ready to save yet:')).toBeVisible();
  await page.getByLabel('Reason for this change', { exact: true }).fill('Launch prices for the pilot');
  await expect(page.getByRole('button', { name: 'Save new version' })).toBeDisabled();

  await page.getByLabel('Version name', { exact: true }).fill('Synthetic launch prices');
  await page.getByLabel('Timezone', { exact: true }).fill('Pacific/Auckland');
  await page.getByLabel('Effective from', { exact: true }).fill('2026-01-01T00:00:00+13:00');
  await page.getByLabel('Pricing date', { exact: true }).selectOption('dispatch');
  await page.getByLabel('Currency', { exact: true }).selectOption('NZD');
  await page.getByLabel('Tax rate', { exact: true }).fill('15');
  await page.getByLabel('Freight taxable', { exact: true }).selectOption('yes');
  await page.getByLabel('Payment due day', { exact: true }).fill('20');
  await page.getByLabel('Due month follows', { exact: true }).selectOption('dispatch');
  await page.getByLabel('Volume tier quantity', { exact: true }).selectOption('ordered');
  await page.getByLabel('Retailers without a price book', { exact: true }).selectOption('default_book');
  await page.getByLabel('Discount combination', { exact: true }).selectOption('single');
  await page.getByLabel('Discounts on special prices', { exact: true }).selectOption('no');
  await page.getByLabel('Price of Synthetic cap in standard', { exact: true }).fill('12.50');
  await page.getByLabel('Price of Synthetic tee in standard', { exact: true }).fill('20.00');
  await page.getByRole('button', { name: 'Add negotiated price' }).click();
  await page.getByLabel('Negotiated 1 retailer', { exact: true }).selectOption({ label: 'Synthetic Export' });
  await page.getByLabel('Negotiated 1 product', { exact: true }).selectOption({ label: 'Synthetic tee (TEE)' });
  await page.getByLabel('Negotiated 1 price', { exact: true }).fill('18.00');
  await page.getByLabel('This business charges freight').check();
  await page.getByRole('button', { name: 'Add shipping rule' }).click();
  await page.getByLabel('Shipping rule 1 charge', { exact: true }).selectOption('fixed');
  await page.getByLabel('Shipping rule 1 fixed charge', { exact: true }).fill('10.00');
  await expect(page.getByText('Not ready to save yet:')).toHaveCount(0);

  // 10 tees at the book price, the first shipment's freight, 15% tax on both.
  await page.getByLabel('Preview retailer', { exact: true }).selectOption({ label: 'Synthetic Retail North' });
  await page.getByLabel('Preview line 1 product', { exact: true }).selectOption({ label: 'Synthetic tee (TEE)' });
  await page.getByRole('button', { name: 'Preview this draft' }).click();
  const draftPreview = page.getByRole('region', { name: 'This draft preview' });
  await expect(draftPreview).toContainText('Products NZD 200.00');
  await expect(draftPreview).toContainText('Freight NZD 10.00');
  await expect(draftPreview).toContainText('Total NZD 241.50');

  await page.getByRole('button', { name: 'Save new version' }).click();
  await expect(page).toHaveURL(/\/pricing\?outcome=saved$/);
  const history = page.getByRole('region', { name: 'Versions' });
  await expect(history).toContainText('Synthetic launch prices');
  await expect(history).toContainText('by operator@example.test');
  await expect(history).toContainText('Saved, not active');

  // Activation previews the saved version on the server's terms: the tax-exempt retailer's
  // 10 caps, its freight, no tax.
  await page.getByLabel('Preview retailer', { exact: true }).selectOption({ label: 'Synthetic Export (tax exempt)' });
  await page.getByLabel('Preview line 1 product', { exact: true }).selectOption({ label: 'Synthetic cap (CAP)' });
  await page.getByRole('button', { name: 'Preview saved version' }).click();
  await expect(page.getByRole('region', { name: 'Saved version preview' })).toContainText('Total NZD 135.00');
  await page.getByLabel('Reason for activating', { exact: true }).fill('Pilot go-live');
  await page.getByRole('button', { name: 'Activate saved version' }).click();
  await expect(page).toHaveURL(/\/pricing\?outcome=activated$/);
  await expect(page.getByRole('region', { name: 'In effect now' })).toContainText('Synthetic launch prices (v1, revision 1)');
  await expect(page.getByRole('region', { name: 'In effect now' })).toContainText('1 Jan 2026');
  await expect(history).toContainText('Active');
  await expect(history).toContainText('Activated');
  await page.screenshot({ path: 'test-results/pricing-activated.png', fullPage: true });
});

test('a pricing save from a page loaded before another save is refused and keeps its draft', async ({ page, context }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  const other = await context.newPage();
  await page.goto('/pricing');
  await other.goto('/pricing');
  // A next version starts with no start time; it must begin after the version in effect.
  await expect(page.getByLabel('Effective from', { exact: true })).toHaveValue('');
  await page.getByLabel('Effective from', { exact: true }).fill('2026-02-01T00:00:00+13:00');
  await page.getByLabel('Price of Synthetic cap in standard', { exact: true }).fill('13.00');
  await page.getByLabel('Reason for this change', { exact: true }).fill('Cap price up');
  await page.getByRole('button', { name: 'Save new version' }).click();
  await expect(page).toHaveURL(/\/pricing\?outcome=saved$/);

  await other.getByLabel('Effective from', { exact: true }).fill('2026-03-01T00:00:00+13:00');
  await other.getByLabel('Price of Synthetic tee in standard', { exact: true }).fill('21.00');
  await other.getByLabel('Reason for this change', { exact: true }).fill('Tee price up');
  await other.getByRole('button', { name: 'Save new version' }).click();
  await expect(other.getByRole('status').filter({ hasText: 'Someone saved a newer version' })).toBeVisible();
  await expect(other).toHaveURL(/\/pricing$/);
  await expect(other.getByLabel('Price of Synthetic tee in standard', { exact: true })).toHaveValue('21.00');
  await page.reload();
  await expect(page.getByRole('region', { name: 'Versions' })).toContainText('Cap price up');
  await expect(page.getByRole('region', { name: 'Versions' })).not.toContainText('Tee price up');
});

test('pricing writes need a signed-in operator posting from the console itself', async ({ page, playwright, baseURL }) => {
  const anonymous = await playwright.request.newContext({ baseURL });
  const draft = { config: {}, expectedRevision: 0, reason: 'from outside' };
  // Without a session the console's gate sends the request to sign in; the route never runs.
  const signedOut = await anonymous.post('/pricing/save', { headers: { Origin: baseURL! }, data: draft, maxRedirects: 0 });
  expect(signedOut.status()).toBe(307);
  expect(signedOut.headers()['location']).toMatch(/\/login/);
  await anonymous.dispose();
  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  const crossSite = await page.request.post('/pricing/activate', { headers: { Origin: 'https://attacker.invalid' },
    data: { versionId: '00000000-0000-4000-8000-000000000000', expectedRevision: 1, reason: 'from outside', previewTotal: '0' } });
  expect(crossSite.status()).toBe(403);
  await page.goto('/pricing');
  await expect(page.getByRole('region', { name: 'Versions' })).not.toContainText('from outside');
});

// Runs after the pricing journeys above, which activated the fixture business's first
// version. The part is drafted through the real BILL path: the shared calculator prices the
// seeded dispatch and the service-only draft function re-checks every amount.
test('owner approves the exact invoice part, issues it, prints it and records the print', async ({ page, request }) => {
  const org = '11111111-1111-4111-8111-111111111111';
  const rest = 'http://127.0.0.1:54321/rest/v1';
  const service = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };
  const one = async (path: string) => {
    const response = await request.get(`${rest}/${path}`, { headers: service });
    expect(response.ok(), await response.text()).toBeTruthy();
    const rows = await response.json(); expect(rows).toHaveLength(1); return rows[0];
  };
  const dispatch = await one(`dispatches?org_id=eq.${org}&source_dispatch_key=eq.ship-print-1&select=id,source_id,source_revision,source_occurred_at,order_key,source_dispatch_key`);
  const line = await one(`dispatch_lines?dispatch_id=eq.${dispatch.id}&active=is.true&select=id,quantity,ordered_quantity`);
  const product = await one(`products?org_id=eq.${org}&sku=eq.TEE&select=id,display_name`);
  const account = await one(`accounts?org_id=eq.${org}&name=eq.Synthetic%20Retail%20North&select=id`);
  const order = await one(`shopify_orders?org_id=eq.${org}&id=eq.${dispatch.order_key}&select=placed_at,shopify_order_name`);
  const activation = await one(`pricing_activations?org_id=eq.${org}&select=version_id`);
  const version = await one(`pricing_versions?org_id=eq.${org}&id=eq.${activation.version_id}&select=config`);
  const now = new Date().toISOString();
  const snapshot = calculatePricing(version.config, {
    businessId: org, accountId: account.id, orderKey: dispatch.order_key, dispatchKey: dispatch.source_dispatch_key,
    orderAt: order.placed_at, dispatchAt: dispatch.source_occurred_at, evaluatedAt: now, destination: null,
    lines: [{ lineId: line.id, productId: product.id, description: product.display_name, ordered: line.ordered_quantity, dispatched: line.quantity, override: null }],
    carrier: null, freightOverride: null, priorParts: 0, taxExempt: false, orderValue: null,
    terms: { kind: 'following_month_day', day: version.config.terms.day, anchor: version.config.terms.anchor, invoiceAt: now },
  });
  expect(snapshot.total).toBe('24150');
  const drafted = await request.post(`${rest}/rpc/draft_dispatch_invoice`, { headers: service, data: {
    p_org_id: org, p_source_id: dispatch.source_id, p_dispatch_id: dispatch.id, p_source_revision: dispatch.source_revision,
    p_pricing_version_id: activation.version_id, p_snapshot: snapshot, p_order_reference: order.shopify_order_name } });
  expect(drafted.ok(), await drafted.text()).toBeTruthy();
  const { invoiceId } = await drafted.json();

  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  // A draft cannot be printed: only the issued invoice is.
  const early = await page.request.get(`/invoices/${invoiceId}/print`);
  expect(early.status()).toBe(409);
  expect(await early.text()).toContain('Approve and issue this invoice before printing it.');

  await page.goto(`/invoices/${invoiceId}`);
  const other = await page.context().newPage();
  await other.goto(`/invoices/${invoiceId}`);
  await expect(page.getByRole('heading', { name: 'Invoice part A of order #5001' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Invoice part A of order #5001' })).toContainText('Due 2026-11-20');
  await expect(page.getByText('20 Nov 2026')).toBeVisible();
  await page.getByLabel('Approval note', { exact: true }).fill('Checked against the packing slip');
  await page.getByRole('button', { name: 'Approve and issue NZD 241.50' }).click();
  await expect(page).toHaveURL(new RegExp(`/invoices/${invoiceId}\\?outcome=issued$`));
  await expect(page.getByTestId('invoice-notice')).toContainText('Invoice approved and issued exactly as shown.');
  await expect(page.getByRole('button', { name: /Approve and issue/ })).toHaveCount(0);

  // A page loaded before the approval cannot issue it again.
  await other.getByRole('button', { name: 'Approve and issue NZD 241.50' }).click();
  await expect(other.getByTestId('invoice-notice')).toContainText('no longer a draft, so nothing was issued');

  const printable = await page.context().newPage();
  await printable.goto(`/invoices/${invoiceId}/print`);
  await expect(printable.getByRole('heading', { name: /^Invoice .+A$/ })).toBeVisible();
  for (const text of ['Order reference: #5001', 'From: Auth browser fixture', 'To: Synthetic Retail North', 'Due date: 2026-11-20', 'NZD 241.50'])
    await expect(printable.locator('body')).toContainText(text);
  await printable.screenshot({ path: 'test-results/invoice-printable.png', fullPage: true });

  const print = page.getByRole('region', { name: 'Print', exact: true });
  await expect(print).toContainText('Not recorded as printed yet.');
  await print.getByRole('button', { name: 'Printing failed' }).click();
  await expect(page.getByTestId('invoice-notice')).toContainText('Say briefly what went wrong');
  await page.getByLabel('Print note', { exact: true }).fill('Printer jammed');
  await page.getByRole('button', { name: 'Printing failed' }).click();
  await expect(page.getByTestId('invoice-notice')).toContainText('Recorded that printing failed.');
  await page.getByRole('button', { name: 'Record as printed' }).click();
  await expect(page.getByTestId('invoice-notice')).toContainText('Recorded as printed, against this exact document.');
  await expect(page.getByText(/Last recorded: printed by operator@example\.test/)).toBeVisible();
  await expect(page.getByRole('list', { name: 'Print history' })).toContainText('printing failed by operator@example.test: Printer jammed');
  await page.screenshot({ path: 'test-results/invoice-printed.png', fullPage: true });
});

// A bank payment lands against the issued part (0043): recorded once from the invoice
// page, posted, and the invoice turns partial. Runs after the approve → print journey
// issued it. The payments.record grant comes from this fixture's seed only — it is
// never seeded at boot; a business turns manual payment entry on deliberately.
test('an operator records a bank payment against the issued invoice', async ({ page, request }) => {
  const org = '11111111-1111-4111-8111-111111111111';
  const rest = 'http://127.0.0.1:54321/rest/v1';
  const service = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };
  const rows = await (await request.get(`${rest}/dispatches?org_id=eq.${org}&source_dispatch_key=eq.ship-print-1&select=id`, { headers: service })).json();
  const parts = await (await request.get(`${rest}/invoice_calculation_snapshots?org_id=eq.${org}&dispatch_id=eq.${rows[0].id}&select=invoice_id`, { headers: service })).json();

  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  await page.goto(`/invoices/${parts[0].invoice_id}`);
  await page.getByLabel('Payment amount', { exact: true }).fill('100.00');
  await page.getByLabel('Payment reference', { exact: true }).fill('BANK-DRILL-1');
  await page.getByRole('button', { name: 'Record payment', exact: true }).click();
  await expect(page.getByTestId('invoice-notice')).toContainText('Payment recorded against this invoice, exactly once');
  await expect(page.locator('body')).toContainText('BANK-DRILL-1');
  // The summary grid renders symbol-style money ($141.50), unlike the printable view.
  await expect(page.locator('body')).toContainText('$141.50');

  // The same reference is a retry, not a second payment: still exactly one row.
  await page.getByLabel('Payment amount', { exact: true }).fill('100.00');
  await page.getByLabel('Payment reference', { exact: true }).fill('BANK-DRILL-1');
  await page.getByRole('button', { name: 'Record payment', exact: true }).click();
  await expect(page.getByTestId('invoice-notice')).toContainText('Payment recorded against this invoice, exactly once');
  await expect(page.getByText('BANK-DRILL-1')).toHaveCount(1);

  // More than what is outstanding is refused with its reason.
  await page.getByLabel('Payment amount', { exact: true }).fill('999.00');
  await page.getByLabel('Payment reference', { exact: true }).fill('BANK-DRILL-2');
  await page.getByRole('button', { name: 'Record payment', exact: true }).click();
  await expect(page.getByTestId('invoice-notice')).toContainText('exceeds what is outstanding');
  await page.screenshot({ path: 'test-results/payment-recorded.png', fullPage: true });
});

// A statement closes the loop (0044): generated from the console after the payment
// above, it reflects the issued invoice minus what was paid, aged in the business's own
// calendar. Runs after the payment journey.
test('an operator generates a retailer statement that reflects the recorded payment', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  await page.goto('/statements');
  await page.getByLabel('Statement retailer', { exact: true }).selectOption({ label: 'Synthetic Retail North' });
  await page.getByLabel('Statement period start', { exact: true }).fill('2026-10-01');
  await page.getByRole('button', { name: 'Generate statement', exact: true }).click();
  await expect(page.getByTestId('statement-notice')).toContainText('Statement generated from the stored records');
  const row = page.locator('tbody tr').filter({ hasText: 'Synthetic Retail North' }).first();
  await expect(row).toContainText('$141.50');
  await page.screenshot({ path: 'test-results/statement-generated.png', fullPage: true });
});

// Runs after the generation journey: its statement is the one printed, sent and voided.
test('an operator prints the statement, records the send, and voids it with a reason', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  await page.goto('/statements');
  await page.locator('tbody tr').filter({ hasText: 'Synthetic Retail North' }).first()
    .getByRole('link').first().click();
  await expect(page.getByRole('heading', { name: 'Statement of account' })).toBeVisible();

  // The customer document: business identity (display-name fallback until a profile is
  // saved), the derivation and the aging — in the invoice document's money style.
  await page.getByRole('link', { name: 'Open printable statement' }).click();
  await expect(page.locator('body')).toContainText('From: Auth browser fixture');
  await expect(page.locator('body')).toContainText('closing NZD 141.50');
  await expect(page.locator('body')).toContainText('To: Synthetic Retail North');
  await page.goBack();

  // Record the send; the fact lands on the row, attributed.
  await page.getByRole('button', { name: 'Record sent', exact: true }).click();
  await expect(page.getByTestId('statement-notice')).toContainText('Recorded as sent');
  await expect(page.getByText('Sent', { exact: false }).filter({ hasText: 'operator@example.test' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record sent', exact: true })).toHaveCount(0);

  // Void it with a reason; the figures stay, the document reprints marked VOID.
  await page.getByLabel('Void reason', { exact: true }).fill('superseded by a browser redraft');
  await page.getByRole('button', { name: 'Void statement', exact: true }).click();
  await expect(page.getByTestId('statement-notice')).toContainText('Statement voided');
  await expect(page.getByTestId('voided-detail')).toContainText('superseded by a browser redraft');
  await expect(page.getByLabel('Void reason', { exact: false })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/statement-voided.png', fullPage: true });
  await page.getByRole('link', { name: 'Open printable statement' }).click();
  await expect(page.locator('body')).toContainText('VOID — superseded by a browser redraft');
  await expect(page.locator('body')).toContainText('closing NZD 141.50');
});

// Runs after the pricing journeys (a version is active). The worker's own invoice part pass
// runs against the disposable stack in its own process from the repository root, as the
// worker does on each tick.
function invoicePartPass(org: string): { succeeded: number; blocked: number } {
  const out = execFileSync('npx', ['tsx', 'scripts/invoice-part-pass.ts', org],
    { cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8', env: process.env });
  return JSON.parse(out.trim().split('\n').at(-1)!);
}
test('the worker drafts a wholesale shipment\'s invoice part; ones it cannot price wait with their reason', async ({ page, request }) => {
  const org = '11111111-1111-4111-8111-111111111111';
  const result = invoicePartPass(org);
  expect(result.succeeded).toBe(1);
  expect(result.blocked).toBeGreaterThan(0);

  const rest = 'http://127.0.0.1:54321/rest/v1';
  const service = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };
  const rows = await (await request.get(`${rest}/dispatches?org_id=eq.${org}&source_dispatch_key=eq.ship-auto-1&select=id`, { headers: service })).json();
  const parts = await (await request.get(`${rest}/invoice_calculation_snapshots?org_id=eq.${org}&dispatch_id=eq.${rows[0].id}&select=invoice_id`, { headers: service })).json();
  expect(parts).toHaveLength(1);
  // A second pass drafts nothing new.
  expect(invoicePartPass(org).succeeded).toBe(0);

  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  await page.goto(`/invoices/${parts[0].invoice_id}`);
  // 4 tees at the book price, the first shipment's freight, 15% tax: priced from stored records only.
  await expect(page.getByRole('heading', { name: 'Invoice part A of order #5002' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve and issue NZD 103.50' })).toBeVisible();

  await page.goto('/jobs');
  const waiting = page.getByRole('region', { name: 'Needs a person' }).getByTestId('job').filter({ hasText: 'Invoice part draft' }).first();
  await expect(waiting).toContainText('does not match exactly one active product');
  await page.screenshot({ path: 'test-results/invoice-part-jobs.png', fullPage: true });
});

// Runs after the worker journey: its drafted part is issued here and then voided (0048),
// so a wrongly issued invoice stops being a live receivable.
test('an operator voids a wrongly issued invoice with a reason; the posting reverses', async ({ page, request }) => {
  const org = '11111111-1111-4111-8111-111111111111';
  const rest = 'http://127.0.0.1:54321/rest/v1';
  const service = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };
  const rows = await (await request.get(`${rest}/dispatches?org_id=eq.${org}&source_dispatch_key=eq.ship-auto-1&select=id`, { headers: service })).json();
  const parts = await (await request.get(`${rest}/invoice_calculation_snapshots?org_id=eq.${org}&dispatch_id=eq.${rows[0].id}&select=invoice_id`, { headers: service })).json();

  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  await page.goto(`/invoices/${parts[0].invoice_id}`);
  await page.getByRole('button', { name: 'Approve and issue NZD 103.50' }).click();
  await expect(page.getByTestId('invoice-notice')).toContainText('Invoice approved and issued exactly as shown');

  await page.getByLabel('Invoice void reason', { exact: true }).fill('issued against the wrong retailer');
  await page.getByRole('button', { name: 'Void invoice', exact: true }).click();
  await expect(page.getByTestId('invoice-notice')).toContainText('Invoice voided and its issue posting reversed');
  await expect(page.getByTestId('invoice-voided')).toContainText('issued against the wrong retailer');
  await expect(page.getByRole('button', { name: 'Void invoice', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Record payment', exact: true })).toHaveCount(0);
  // The reversal is visible beside the issue posting in the invoice's own ledger.
  await expect(page.getByText('Invoice ATL-', { exact: false }).filter({ hasText: 'voided' }).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/invoice-voided.png', fullPage: true });
});

// Runs after the void journey, so the ledger carries issues, a payment and a reversal.
test('the ledger page shows postings and exports the period as exact CSV', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  await page.goto('/ledger');
  await expect(page.getByTestId('ledger-txn').filter({ hasText: 'voided' }).first()).toBeVisible();
  await expect(page.getByTestId('ledger-txn').filter({ hasText: 'Payment received' }).first()).toBeVisible();

  await page.getByLabel('Export from', { exact: true }).fill('2026-01-01');
  await page.getByLabel('Export to', { exact: true }).fill('2027-01-01');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export CSV', exact: true }).click(),
  ]);
  const file = await download.path();
  const csv = readFileSync(file!, 'utf8');
  const lines = csv.trim().split('\r\n');
  expect(lines[0]).toBe('posted_at,occurred_at,transaction_id,source,description,account_code,account_name,memo,amount,currency');
  // The voided part's issue and its reversal both export, and they cancel exactly.
  expect(csv).toContain('invoice_voided');
  expect(csv).toContain(',103.50,');
  expect(csv).toContain(',-103.50,');
  expect(csv).toContain('payment_received');
  expect(lines.length).toBeGreaterThan(6);

  // A nonsense period exports nothing and says so.
  await page.goto('/ledger/export?from=2026-12-31&to=2026-01-01');
  await expect(page.getByTestId('ledger-notice')).toContainText('Check the period');
  await page.screenshot({ path: 'test-results/ledger.png', fullPage: true });
});


// Catalogue (0040, CONFIG-01a): runs last — it adds a product and a retailer, which
// earlier journeys' counts must not see. Cross-business rows stay invisible, creates
// land with a confirmation, a duplicate SKU is refused with its reason, and an edit
// carries the loaded row's timestamp so a stale page cannot overwrite a newer change.
test('an operator sets up the catalogue in the console: list, create, duplicate refusal, edit', async ({ page }) => {
  await login(page);
  // Wait for the signed-in landing before navigating: a goto during the login's token
  // request aborts it, leaving no session.
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  await page.goto('/catalog');
  await expect(page.getByRole('heading', { name: 'Catalogue' })).toBeVisible();
  // This business's rows, never the other business's. Values live in form inputs, so
  // the assertions read display values, not text content.
  await expect(page.getByTestId('product').filter({ has: page.locator('input[value="TEE"]') })).toHaveCount(1);
  await expect(page.getByTestId('retailer').filter({ has: page.locator('input[value="Synthetic Retail North"]') })).toHaveCount(1);
  await expect(page.locator('input[value*="OTHER-SECRET"]')).toHaveCount(0);

  // Create a product.
  await page.getByLabel('New product SKU', { exact: true }).fill('GIZMO');
  await page.getByLabel('New product name', { exact: true }).fill('Browser gizmo');
  await page.getByRole('button', { name: 'Add product', exact: true }).click();
  await expect(page.getByTestId('catalog-notice')).toContainText('Product saved.');
  const gizmo = page.getByTestId('product').filter({ hasText: 'Created in the console.' }).filter({ has: page.locator('input[value="GIZMO"]') });
  await expect(gizmo).toHaveCount(1);

  // A duplicate SKU is refused with its reason, and nothing is added.
  await page.getByLabel('New product SKU', { exact: true }).fill('TEE');
  await page.getByLabel('New product name', { exact: true }).fill('Impostor tee');
  await page.getByRole('button', { name: 'Add product', exact: true }).click();
  await expect(page.getByTestId('catalog-notice')).toContainText('A product with that SKU already exists');
  await expect(page.getByTestId('product').filter({ has: page.locator('input[value="Impostor tee"]') })).toHaveCount(0);

  // Create a retailer and edit it: the row form carries the loaded timestamp.
  await page.getByLabel('New retailer name', { exact: true }).fill('Browser Retail');
  await page.getByLabel('New retailer currency', { exact: true }).fill('NZD');
  await page.getByRole('button', { name: 'Add retailer', exact: true }).click();
  await expect(page.getByTestId('catalog-notice')).toContainText('Retailer saved.');
  const retailer = page.getByTestId('retailer').filter({ has: page.locator('input[value="Browser Retail"]') });
  await expect(retailer).toHaveCount(1);
  await retailer.getByLabel('Terms days of Browser Retail', { exact: true }).fill('30');
  await retailer.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('catalog-notice')).toContainText('Retailer saved.');
  await expect(page.getByTestId('retailer').filter({ has: page.locator('input[value="Browser Retail"]') })
    .getByLabel('Terms days of Browser Retail', { exact: true })).toHaveValue('30');
  await page.screenshot({ path: 'test-results/catalog.png', fullPage: true });
});

// The business profile (0045): saved in the console and carried by the printed invoice
// from the next print — legal name as From, the tax number under the business's own
// label, and the bank payment instructions a transfer needs. Runs after the statement
// journey; the invoice printed here was issued earlier.
test('the printed invoice carries the saved business profile', async ({ page, request }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  await page.goto('/business');
  await page.getByLabel('Legal name', { exact: true }).fill('Auth Browser Fixtures Ltd');
  await page.getByLabel('Tax number label', { exact: true }).fill('GST number');
  await page.getByLabel('Tax number', { exact: true }).fill('123-456-789');
  await page.getByLabel('Payment instructions', { exact: true }).fill('Bank 00-0000-0000000-00 — reference the invoice number');
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByTestId('profile-notice')).toContainText('Business profile saved.');

  const org = '11111111-1111-4111-8111-111111111111';
  const rest = 'http://127.0.0.1:54321/rest/v1';
  const service = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };
  const rows = await (await request.get(`${rest}/dispatches?org_id=eq.${org}&source_dispatch_key=eq.ship-print-1&select=id`, { headers: service })).json();
  const parts = await (await request.get(`${rest}/invoice_calculation_snapshots?org_id=eq.${org}&dispatch_id=eq.${rows[0].id}&select=invoice_id`, { headers: service })).json();
  await page.goto(`/invoices/${parts[0].invoice_id}/print`);
  for (const text of ['From: Auth Browser Fixtures Ltd', 'GST number: 123-456-789', 'Bank 00-0000-0000000-00'])
    await expect(page.locator('body')).toContainText(text);
  await page.screenshot({ path: 'test-results/invoice-with-profile.png', fullPage: true });
});

// The Shopify connection (0042): the seeded business already has its one connection
// with a blocked sync job, so the journey edits it — cadence, disable with its warning,
// re-enable — and sees the fixed domain and the sync's honest blocked reason.
test('an operator manages the Shopify connection in the console', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  await page.goto('/connections');
  await expect(page.getByRole('heading', { name: 'Connections' })).toBeVisible();
  const connection = page.getByTestId('connection');
  await expect(connection).toContainText('jobs-1111.myshopify.com');
  await expect(connection).toContainText('cannot change');
  await expect(page.getByTestId('connection-sync')).toContainText('Sync blocked: SHOPIFY_ADMIN_API_TOKEN must be set');

  await connection.getByLabel('Sync cadence minutes', { exact: true }).fill('30');
  await connection.getByRole('button', { name: 'Save connection', exact: true }).click();
  await expect(page.getByTestId('connection-notice')).toContainText('Connection saved.');
  await expect(page.getByTestId('connection').getByLabel('Sync cadence minutes', { exact: true })).toHaveValue('30');

  // Disable, see the warning, re-enable: the journey leaves the connection enabled.
  await page.getByTestId('connection').getByRole('checkbox').uncheck();
  await page.getByTestId('connection').getByRole('button', { name: 'Save connection', exact: true }).click();
  await expect(page.getByTestId('connection-notice')).toContainText('Connection saved.');
  await expect(page.getByTestId('connection')).toContainText('Disabled: nothing syncs');
  await page.getByTestId('connection').getByRole('checkbox').check();
  await page.getByTestId('connection').getByRole('button', { name: 'Save connection', exact: true }).click();
  await expect(page.getByTestId('connection-notice')).toContainText('Connection saved.');
  await expect(page.getByTestId('connection')).not.toContainText('Disabled: nothing syncs');
  await page.screenshot({ path: 'test-results/connections.png', fullPage: true });
});

// Membership (0049): second@ is on the environment allowlist but is NOT a seeded member,
// so until added here they cannot sign in — membership gates on top of the allowlist.
// Disabling them cuts access on their next request; the lockout guards hold.
test('membership gates the console on top of the allowlist; disabling a member takes effect at once', async ({ page, browser }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();

  // Not yet a member: the allowlist alone does not admit them.
  const outsider = await browser.newContext();
  const outsiderPage = await outsider.newPage();
  await login(outsiderPage, 'second@example.test');
  await expect(outsiderPage.getByText('This account is not on the operator allowlist.')).toBeVisible();

  await page.goto('/members');
  await expect(page.getByTestId('member-row').filter({ hasText: 'operator@example.test' })).toContainText('(you)');
  await page.getByLabel('Member email', { exact: true }).fill('second@example.test');
  await page.getByRole('button', { name: 'Add member', exact: true }).click();
  await expect(page.getByTestId('member-notice')).toContainText('Membership saved');

  // Now a member: they reach the console.
  await login(outsiderPage, 'second@example.test');
  await expect(outsiderPage.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();

  // Disable them; their very next request is refused and their session is cleared.
  await page.getByRole('button', { name: 'Disable second@example.test', exact: true }).click();
  await expect(page.getByTestId('member-notice')).toContainText('Membership saved');
  await outsiderPage.goto('/invoices');
  await expect(outsiderPage.getByText('This account is not on the operator allowlist.')).toBeVisible();

  // Re-enable restores access on a fresh sign-in.
  await page.getByRole('button', { name: 'Enable second@example.test', exact: true }).click();
  await expect(page.getByTestId('member-notice')).toContainText('Membership saved');
  await login(outsiderPage, 'second@example.test');
  await expect(outsiderPage.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  await outsider.close();

  // Lockout guard: you can never disable your own membership.
  await page.getByRole('button', { name: 'Disable operator@example.test', exact: true }).click();
  await expect(page.getByTestId('member-notice')).toContainText('You cannot disable your own membership');
  // Still enabled: the row still offers Disable (a disabled row would offer Enable).
  await expect(page.getByRole('button', { name: 'Disable operator@example.test', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/members.png', fullPage: true });
});

// The emergency stop (0041): runs last of all — it pauses the business, which every
// earlier journey's forms must not see. The pause lands durably with who and why, the
// catalogue page says so and hides its forms, and resume works from the banner while
// paused.
test('an operator pauses and resumes all business actions from the console', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  await page.getByLabel('Pause reason', { exact: true }).fill('Browser drill');
  await page.getByRole('button', { name: 'Pause business actions', exact: true }).click();
  await expect(page.getByTestId('controls-notice')).toContainText('Business actions are paused.');
  const banner = page.getByTestId('pause-banner');
  await expect(banner).toContainText('operator@example.test');
  await expect(banner).toContainText('Browser drill');
  await page.screenshot({ path: 'test-results/paused.png', fullPage: true });

  // Every page reads the same durable control; the catalogue hides its forms.
  await page.goto('/catalog');
  await expect(page.locator('body')).toContainText('Business actions are paused, so the catalogue cannot be changed');
  await expect(page.getByRole('button', { name: 'Add product', exact: true })).toHaveCount(0);

  await page.goto('/');
  await page.getByLabel('Resume reason', { exact: true }).fill('Drill over');
  await page.getByRole('button', { name: 'Resume business actions', exact: true }).click();
  await expect(page.getByTestId('controls-notice')).toContainText('Business actions are resumed.');
  await expect(page.getByTestId('pause-banner')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/pause-resumed.png', fullPage: true });
});
