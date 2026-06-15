type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function active(): number {
  const lvl = (process.env.ATLAS_LOG_LEVEL ?? 'info') as Level;
  return order[lvl] ?? order.info;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (order[level] < active()) return;
  const line = { ts: new Date().toISOString(), level, msg, ...fields };
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(JSON.stringify(line) + '\n');
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
  info:  (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  warn:  (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
};
