import assert from 'node:assert/strict';
import test from 'node:test';
import { NextResponse } from 'next/server';
import { authEnv, normalizeProjectUrl, operatorAllowed } from '../lib/auth';
import { redirectWithCookies } from '../lib/auth-response';

test('operator allowlist fails closed when empty or missing an email', () => {
  assert.equal(operatorAllowed('operator@example.com', ''), false);
  assert.equal(operatorAllowed(null, 'operator@example.com'), false);
  assert.equal(operatorAllowed(undefined, 'operator@example.com'), false);
});

test('operator allowlist trims entries and compares case-insensitively', () => {
  const allowlist = ' first@example.com, Operator@Example.com ';
  assert.equal(operatorAllowed(' operator@example.com ', allowlist), true);
  assert.equal(operatorAllowed('stranger@example.com', allowlist), false);
});

test('project URL normalization handles equivalent trailing slashes', () => {
  assert.equal(
    normalizeProjectUrl('https://project.supabase.co/'),
    'https://project.supabase.co',
  );
  assert.equal(
    normalizeProjectUrl('HTTPS://PROJECT.SUPABASE.CO'),
    'https://project.supabase.co',
  );
});

test('project URL normalization rejects malformed or decorated URLs', () => {
  assert.equal(normalizeProjectUrl(undefined), null);
  assert.equal(normalizeProjectUrl('not a URL'), null);
  assert.equal(normalizeProjectUrl('javascript:alert(1)'), null);
  assert.equal(normalizeProjectUrl('https://user:pass@project.supabase.co'), null);
  assert.equal(normalizeProjectUrl('https://project.supabase.co?other=1'), null);
  assert.equal(normalizeProjectUrl('https://project.supabase.co#other'), null);
});

test('auth environment fails closed when configuration is incomplete', () => {
  assert.equal(authEnv({}), null);
  assert.equal(
    authEnv({
      SUPABASE_URL: 'https://project.supabase.co',
      NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
    }),
    null,
  );
});

test('auth environment rejects a different service-role data project', () => {
  assert.equal(
    authEnv({
      SUPABASE_URL: 'https://data.supabase.co',
      NEXT_PUBLIC_SUPABASE_URL: 'https://auth.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
    }),
    null,
  );
});

test('auth environment accepts one normalized Supabase project', () => {
  assert.deepEqual(
    authEnv({
      SUPABASE_URL: 'https://project.supabase.co/',
      NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
    }),
    { url: 'https://project.supabase.co', anonKey: 'anon-key' },
  );
});

test('redirects retain refreshed and cleared Supabase cookies', () => {
  const cookieResponse = NextResponse.next();
  cookieResponse.cookies.set('sb-access', 'fresh', {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
  });
  cookieResponse.cookies.set('sb-refresh', '', { maxAge: 0, path: '/' });

  const redirect = redirectWithCookies(
    new URL('https://console.example/login'),
    cookieResponse,
    302,
  );

  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'https://console.example/login');
  assert.equal(redirect.cookies.get('sb-access')?.value, 'fresh');
  assert.equal(redirect.cookies.get('sb-access')?.httpOnly, true);
  assert.equal(redirect.cookies.get('sb-refresh')?.maxAge, 0);
});
