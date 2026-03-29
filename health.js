/**
 * Health check module for Tavole bot.
 * Provides /health endpoint with system status for monitoring.
 */

import { getDbBackend } from './db.js';
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

/**
 * Express handler: GET /health
 * Returns 200 always — memory fallback is a valid operating mode.
 */
export function healthHandler(_req, res) {
  const backend = getDbBackend();

  const payload = {
    status: 'ok',
    version: '2.0.0',
    uptime_s: uptimeSeconds(),
    started_at: startedAt,
    messages_processed: messageCount,
    last_message_at: lastMessageAt,
    checks: {
      database: {
        ok: true,
        backend,
        note: backend === 'memory' ? 'In-memory store (ephemeral, resets on restart)' : 'SQLite on disk',
      },
    },
    env: process.env.NODE_ENV || 'development',
  };

  res.status(200).json(payload);
}
