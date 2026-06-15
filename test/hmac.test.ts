import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyWebhookHmac } from '../src/integrations/shopify/hmac.js';

test('verifyWebhookHmac accepts a valid signature', () => {
  process.env.SHOPIFY_WEBHOOK_SECRET = 'test-secret';
  const body = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8');
  const sig = createHmac('sha256', 'test-secret').update(body).digest('base64');
  assert.equal(verifyWebhookHmac(body, sig), true);
});

test('verifyWebhookHmac rejects an invalid signature', () => {
  process.env.SHOPIFY_WEBHOOK_SECRET = 'test-secret';
  const body = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8');
  assert.equal(verifyWebhookHmac(body, 'not-the-right-sig'), false);
});

test('verifyWebhookHmac rejects when signature header is missing', () => {
  process.env.SHOPIFY_WEBHOOK_SECRET = 'test-secret';
  const body = Buffer.from('{}', 'utf8');
  assert.equal(verifyWebhookHmac(body, undefined), false);
});
