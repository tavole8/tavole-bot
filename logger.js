/**
 * Structured JSON logger for Tavole bot.
 * Outputs one JSON line per log entry for easy parsing by PM2, CloudWatch, etc.
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info'];

function formatLog(level, event, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  };
  return JSON.stringify(entry);
}

function shouldLog(level) {
  return (LOG_LEVELS[level] ?? 1) >= CURRENT_LEVEL;
}

export function debug(event, data) {
  if (shouldLog('debug')) console.log(formatLog('debug', event, data));
}

export function info(event, data) {
  if (shouldLog('info')) console.log(formatLog('info', event, data));
}

export function warn(event, data) {
  if (shouldLog('warn')) console.warn(formatLog('warn', event, data));
}

export function error(event, data) {
  if (shouldLog('error')) console.error(formatLog('error', event, data));
}

export default { debug, info, warn, error };
