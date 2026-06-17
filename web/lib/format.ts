// Display helpers shared across console pages. Pure functions, no IO.

/**
 * Format minor units (cents) as a currency string. Defaults to en-NZ formatting since
 * v1 is VICE-specific (NZD wholesale); the locale param lets later orgs override.
 */
export function formatCents(
  amountCents: number | bigint | string | null | undefined,
  currency: string,
  locale = 'en-NZ',
): string {
  if (amountCents == null) return '—';
  const num = typeof amountCents === 'string' ? Number(amountCents) : Number(amountCents);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(num / 100);
}

/**
 * Format an ISO date string as "Jun 16, 2026" by default. Pass kind='short' for
 * "16/06/2026" or 'long' for "Tuesday, 16 June 2026".
 */
export function formatDate(
  iso: string | null | undefined,
  kind: 'short' | 'medium' | 'long' = 'medium',
  locale = 'en-NZ',
): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const opts: Intl.DateTimeFormatOptions =
    kind === 'short'
      ? { year: 'numeric', month: '2-digit', day: '2-digit' }
      : kind === 'long'
        ? { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }
        : { year: 'numeric', month: 'short', day: 'numeric' };
  return new Intl.DateTimeFormat(locale, opts).format(d);
}

/**
 * "Jun 16, 11:34am" — used in dense tables where the year is implied.
 */
export function formatDateTime(iso: string | null | undefined, locale = 'en-NZ'): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
