import { test, expect, type Page } from '@playwright/test';

const authUrl = 'http://127.0.0.1:54321/auth/v1';
const password = 'disposable-atlas-browser-password';
async function login(page: Page, email = 'operator@example.test') {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
test.beforeAll(async ({ request }) => {
  for (const email of ['operator@example.test', 'denied@example.test']) {
    const response = await request.post(`${authUrl}/admin/users`, {
      headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
      data: { email, password, email_confirm: true },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
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

test('operator sees blocked and quarantined jobs with their reason, and no other business\'s jobs', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  await page.getByRole('link', { name: 'Jobs', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Background jobs' })).toBeVisible();
  await expect(page.getByTestId('last-run')).toContainText(/Last worker run \d+m ago/);
  // The seeded pending job has been due for 30 minutes with no worker running.
  await expect(page.getByTestId('overdue')).toContainText('1 job is overdue by more than 10 minutes');

  const attention = page.getByRole('region', { name: 'Needs a person' }).getByTestId('job');
  await expect(attention).toHaveCount(2);
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

  const retrying = page.getByRole('region', { name: 'Retrying' }).getByTestId('job');
  await expect(retrying).toHaveCount(1);
  await expect(retrying).toContainText('HTTP 503');
  await expect(page.getByRole('region', { name: 'Queued and running' }).getByTestId('job')).toHaveCount(1);
  await expect(page.getByText('OTHER-BUSINESS-SECRET-ERROR')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/jobs.png', fullPage: true });
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
  await expect(page.getByRole('region', { name: 'Needs a person' })).toContainText('Nothing is blocked.');
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
