/**
 * Health check module for Tavole bot.
 * Provides /health endpoint with system status for monitoring.
 */

import Database from 'better-sqlite3';
import config from './config.js';

const startedAt = new Date().toISOString();
let messageCount = 0;
let lastMessageAt = null;

/** Call this on every incoming message to track activity. */
export function recordMessage() {
  messageCount++;
  lastMessageAt = new Date().toISOString();
}

/** Get uptime in seconds. */
function uptimeSeconds() {
  return Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
}

/** Check if SQLite DB is readable. */
function checkDatabase() {
  try {
    const db = new Database(config.dbPath || './data/tavole.db', { readonly: true });
    const row = db.prepare('SELECT COUNT(*) as cnt FROM users').get();
    db.close();
    return { ok: true, users: row.cnt };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Express handler: GET /health
 * Returns 200 if healthy, 503 if critical check fails.
 */
export function healthHandler(_req, res) {
  const db = checkDatabase();
  const healthy = db.ok;

  const payload = {
    status: healthy ? 'ok' : 'degraded',
    version: '2.0.0',
    uptime_s: uptimeSeconds(),
    started_at: startedAt,
    messages_processed: messageCount,
    last_message_at: lastMessageAt,
    checks: {
      database: db,
    },
    env: process.env.NODE_ENV || 'development',
  };

  res.status(healthy ? 200 : 503).json(payload);
}
