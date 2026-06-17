// Inline state pill. Color picked from a small enum to keep usage typesafe.

export type BadgeTone =
  | 'neutral'
  | 'blue'
  | 'green'
  | 'amber'
  | 'red'
  | 'zinc';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200',
  zinc: 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200',
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  green: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: React.ReactNode }) {
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${TONE_CLASSES[tone]}`}>
      {children}
    </span>
  );
}

/**
 * Color map for invoice_state values from migration 0003. Pure mapping so it can be
 * reused on detail + list pages.
 */
export function invoiceStateTone(state: string): BadgeTone {
  switch (state) {
    case 'draft':
      return 'zinc';
    case 'issued':
      return 'blue';
    case 'partial':
      return 'amber';
    case 'paid':
      return 'green';
    case 'void':
      return 'red';
    default:
      return 'neutral';
  }
}

export function statementStateTone(state: string): BadgeTone {
  switch (state) {
    case 'draft':
      return 'zinc';
    case 'sent':
      return 'green';
    case 'voided':
      return 'red';
    default:
      return 'neutral';
  }
}
