import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a Shopify webhook HMAC. Returns true iff the signature on the raw body matches the
 * shared secret. Constant-time comparison.
 */
export function verifyWebhookHmac(rawBody: Buffer | string, headerSignature: string | undefined): boolean {
  if (!headerSignature) return false;
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) throw new Error('SHOPIFY_WEBHOOK_SECRET must be set');
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const digest = createHmac('sha256', secret).update(body).digest('base64');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(headerSignature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
