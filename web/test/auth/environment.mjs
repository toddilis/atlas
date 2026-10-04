import { createHmac } from 'node:crypto';
import { appendFileSync } from 'node:fs';
const secret = 'atlas-disposable-auth-test-secret-at-least-32-chars';
function key(role) {
  const body = [ { alg: 'HS256', typ: 'JWT' }, { role, iss: 'supabase', exp: Math.floor(Date.now()/1000)+3600 } ]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
const environment = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: key('anon'),
  SUPABASE_SERVICE_ROLE_KEY: key('service_role'),
  ATLAS_ORG_ID: '11111111-1111-4111-8111-111111111111',
  ATLAS_OPERATOR_EMAILS: 'operator@example.test',
};
if (!process.env.GITHUB_ENV) throw new Error('Run in disposable CI; environment is test-only.');
appendFileSync(process.env.GITHUB_ENV, Object.entries(environment).map(([k,v]) => `${k}=${v}\n`).join(''));
