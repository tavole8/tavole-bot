import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import config from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Use /tmp on Railway (writable), local data/ dir otherwise
const isRailway = !!process.env.RAILWAY_ENVIRONMENT;
const dataDir = isRailway ? '/tmp/tavole-data' : join(__dirname, 'data');
mkdirSync(dataDir, { recursive: true });
const DB_PATH = join(dataDir, 'conversations.db');
console.log('[DB] Railway env:', !!process.env.RAILWAY_ENVIRONMENT, '| Data dir:', dataDir, '| DB path:', DB_PATH);

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    phone TEXT PRIMARY KEY,
    name TEXT,
    language TEXT DEFAULT 'es',
    conversation_state TEXT DEFAULT 'chatting',
    last_service_detected TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    total_messages INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_phone TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    timestamp TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_phone) REFERENCES users(phone)
  );

  CREATE TABLE IF NOT EXISTS daily_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_phone TEXT NOT NULL,
    date TEXT NOT NULL,
    message_count INTEGER DEFAULT 0,
    UNIQUE(user_phone, date)
  );

  CREATE TABLE IF NOT EXISTS conversation_costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_phone TEXT NOT NULL,
    timestamp TEXT DEFAULT (datetime('now')),
    duration_ms INTEGER DEFAULT 0,
    estimated_cost_usd REAL DEFAULT 0,
    model TEXT DEFAULT 'unknown',
    FOREIGN KEY (user_phone) REFERENCES users(phone)
  );

  CREATE TABLE IF NOT EXISTS job_states (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_phone TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_quote',
    tier TEXT,
    description TEXT,
    quoted_price_mxn REAL,
    tokens_used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_credits (
    user_phone TEXT PRIMARY KEY,
    balance_mxn REAL DEFAULT 0,
    total_purchased_mxn REAL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS credit_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_phone TEXT NOT NULL,
    type TEXT NOT NULL,
    amount_mxn REAL NOT NULL,
    description TEXT,
    balance_after_mxn REAL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS deliverables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_phone TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT,
    scope_summary TEXT,
    price_mxn INTEGER,
    status TEXT DEFAULT 'quoted',
    mercadopago_id TEXT,
    quoted_at TEXT DEFAULT (datetime('now')),
    paid_at TEXT,
    delivered_at TEXT,
    FOREIGN KEY (user_phone) REFERENCES users(phone)
  );

  CREATE INDEX IF NOT EXISTS idx_deliverables_phone ON deliverables(user_phone);
  CREATE INDEX IF NOT EXISTS idx_deliverables_status ON deliverables(status);

  CREATE INDEX IF NOT EXISTS idx_messages_user_phone ON messages(user_phone);
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  CREATE INDEX IF NOT EXISTS idx_daily_usage_phone_date ON daily_usage(user_phone, date);
  CREATE INDEX IF NOT EXISTS idx_costs_phone ON conversation_costs(user_phone);
  CREATE INDEX IF NOT EXISTS idx_job_states_phone ON job_states(user_phone);
  CREATE INDEX IF NOT EXISTS idx_job_states_status ON job_states(status);
  CREATE INDEX IF NOT EXISTS idx_credit_transactions_phone ON credit_transactions(user_phone);

  -- v3: User Profiles (Layer 2 memory)
  CREATE TABLE IF NOT EXISTS user_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_phone TEXT UNIQUE NOT NULL,
    profile_json TEXT DEFAULT '{}',
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- v3: Projects (Layer 3 memory)
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_phone TEXT NOT NULL,
    project_type TEXT NOT NULL,
    project_name TEXT,
    context_json TEXT DEFAULT '{}',
    status TEXT DEFAULT 'active',
    credits_consumed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_projects_phone ON projects(user_phone);
  CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(user_phone, status);

  -- v3: Credit Balances
  CREATE TABLE IF NOT EXISTS credit_balances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_phone TEXT UNIQUE NOT NULL,
    balance INTEGER DEFAULT 0,
    total_purchased INTEGER DEFAULT 0,
    total_consumed INTEGER DEFAULT 0,
    last_purchase_amount INTEGER,
    last_purchase_date TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- v3: Credit Transactions (new schema with balance_after, metadata)
  CREATE TABLE IF NOT EXISTS credit_transactions_v3 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_phone TEXT NOT NULL,
    amount INTEGER NOT NULL,
    type TEXT NOT NULL,
    description TEXT,
    balance_after INTEGER NOT NULL DEFAULT 0,
    reference_id TEXT,
    metadata_json TEXT,
    project_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_credit_tx_v3_phone ON credit_transactions_v3(user_phone);
  CREATE INDEX IF NOT EXISTS idx_credit_tx_v3_date ON credit_transactions_v3(created_at);
  CREATE INDEX IF NOT EXISTS idx_credit_tx_v3_type ON credit_transactions_v3(type);
`);

// Migrate: add model column to conversation_costs if missing
try {
  db.prepare("SELECT model FROM conversation_costs LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE conversation_costs ADD COLUMN model TEXT DEFAULT 'unknown'");
}

// Migrate: add conversation_state column to users if missing
try {
  db.prepare("SELECT conversation_state FROM users LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE users ADD COLUMN conversation_state TEXT DEFAULT 'chatting'");
}

// Migrate: add last_service_detected column to users if missing
try {
  db.prepare("SELECT last_service_detected FROM users LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE users ADD COLUMN last_service_detected TEXT");
}

// Prepared statements
const stmts = {
  getUser: db.prepare('SELECT * FROM users WHERE phone = ?'),
  createUser: db.prepare('INSERT OR IGNORE INTO users (phone) VALUES (?)'),
  updateMessageCount: db.prepare('UPDATE users SET total_messages = total_messages + 1 WHERE phone = ?'),
  updateUserName: db.prepare('UPDATE users SET name = ? WHERE phone = ?'),
  saveMessage: db.prepare('INSERT INTO messages (user_phone, role, content) VALUES (?, ?, ?)'),
  getHistory: db.prepare(
    'SELECT role, content FROM messages WHERE user_phone = ? ORDER BY id DESC LIMIT ?'
  ),
  // Rate limiting (now used for lifetime free message tracking)
  getTotalUsage: db.prepare(
    'SELECT COALESCE(SUM(message_count), 0) AS total FROM daily_usage WHERE user_phone = ?'
  ),
  getDailyUsage: db.prepare(
    'SELECT message_count FROM daily_usage WHERE user_phone = ? AND date = ?'
  ),
  upsertDailyUsage: db.prepare(`
    INSERT INTO daily_usage (user_phone, date, message_count)
    VALUES (?, ?, 1)
    ON CONFLICT(user_phone, date)
    DO UPDATE SET message_count = message_count + 1
  `),
  // Cost logging
  logCost: db.prepare(
    'INSERT INTO conversation_costs (user_phone, duration_ms, estimated_cost_usd, model) VALUES (?, ?, ?, ?)'
  ),
  // Job states
  createJob: db.prepare(
    'INSERT INTO job_states (user_phone, status, tier, description, quoted_price_mxn) VALUES (?, ?, ?, ?, ?)'
  ),
  getActiveJob: db.prepare(
    "SELECT * FROM job_states WHERE user_phone = ? AND status IN ('quoted', 'confirmed', 'in_progress') ORDER BY id DESC LIMIT 1"
  ),
  getPendingQuote: db.prepare(
    "SELECT * FROM job_states WHERE user_phone = ? AND status = 'quoted' ORDER BY id DESC LIMIT 1"
  ),
  getInProgressJob: db.prepare(
    "SELECT * FROM job_states WHERE user_phone = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1"
  ),
  updateJobStatus: db.prepare(
    "UPDATE job_states SET status = ?, updated_at = datetime('now') WHERE id = ?"
  ),
  updateJobTokens: db.prepare(
    "UPDATE job_states SET tokens_used = tokens_used + ?, updated_at = datetime('now') WHERE id = ?"
  ),
  // Conversation state
  updateConversationState: db.prepare(
    "UPDATE users SET conversation_state = ? WHERE phone = ?"
  ),
  updateLastServiceDetected: db.prepare(
    "UPDATE users SET last_service_detected = ? WHERE phone = ?"
  ),
  // v3: User Profiles
  getProfile: db.prepare('SELECT * FROM user_profiles WHERE user_phone = ?'),
  upsertProfile: db.prepare(`
    INSERT INTO user_profiles (user_phone, profile_json, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_phone)
    DO UPDATE SET profile_json = excluded.profile_json, updated_at = datetime('now')
  `),

  // v3: Projects
  createProject: db.prepare(`
    INSERT INTO projects (user_phone, project_type, project_name, context_json)
    VALUES (?, ?, ?, ?)
  `),
  getActiveProjects: db.prepare(
    "SELECT * FROM projects WHERE user_phone = ? AND status = 'active' ORDER BY updated_at DESC"
  ),
  getProjectById: db.prepare('SELECT * FROM projects WHERE id = ?'),
  updateProjectContext: db.prepare(
    "UPDATE projects SET context_json = ?, updated_at = datetime('now') WHERE id = ?"
  ),
  updateProjectStatus: db.prepare(
    "UPDATE projects SET status = ?, updated_at = datetime('now') WHERE id = ?"
  ),
  addProjectCredits: db.prepare(
    "UPDATE projects SET credits_consumed = credits_consumed + ?, updated_at = datetime('now') WHERE id = ?"
  ),

  // v3: Credit Balances
  getCreditBalance: db.prepare('SELECT * FROM credit_balances WHERE user_phone = ?'),
  upsertCreditBalance: db.prepare(`
    INSERT INTO credit_balances (user_phone, balance, total_purchased, total_consumed, last_purchase_amount, last_purchase_date, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_phone)
    DO UPDATE SET balance = excluded.balance, total_purchased = excluded.total_purchased,
      total_consumed = excluded.total_consumed, last_purchase_amount = excluded.last_purchase_amount,
      last_purchase_date = excluded.last_purchase_date, updated_at = datetime('now')
  `),

  // v3: Credit Transactions
  insertCreditTx: db.prepare(`
    INSERT INTO credit_transactions_v3 (user_phone, amount, type, description, balance_after, reference_id, metadata_json, project_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getCreditTxHistory: db.prepare(
    'SELECT * FROM credit_transactions_v3 WHERE user_phone = ? ORDER BY created_at DESC LIMIT ?'
  ),

  // Deliverables
  createDeliverable: db.prepare(`
    INSERT INTO deliverables (user_phone, category, description, scope_summary, price_mxn)
    VALUES (?, ?, ?, ?, ?)
  `),
  getPendingDeliverable: db.prepare(
    "SELECT * FROM deliverables WHERE user_phone = ? AND status = 'quoted' ORDER BY id DESC LIMIT 1"
  ),
  getActiveDeliverable: db.prepare(
    "SELECT * FROM deliverables WHERE user_phone = ? AND status IN ('quoted', 'paid', 'in_progress') ORDER BY id DESC LIMIT 1"
  ),
  updateDeliverableStatus: db.prepare(
    "UPDATE deliverables SET status = ? WHERE id = ?"
  ),
  updateDeliverablePaid: db.prepare(
    "UPDATE deliverables SET status = 'paid', mercadopago_id = ?, paid_at = datetime('now') WHERE id = ?"
  ),
  updateDeliverableDelivered: db.prepare(
    "UPDATE deliverables SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?"
  ),
};

// ── User Management ─────────────────────────────────────────────────

/**
 * Get or create a user record by phone number.
 * Returns { user, isNew } where isNew is true if the user was just created.
 */
export function getOrCreateUser(phone) {
  const existing = stmts.getUser.get(phone);
  if (existing) {
    return { user: existing, isNew: false };
  }
  stmts.createUser.run(phone);
  const user = stmts.getUser.get(phone);
  return { user, isNew: true };
}

/**
 * Save a message to the conversation history.
 */
export function saveMessage(userPhone, role, content) {
  stmts.saveMessage.run(userPhone, role, content);
  stmts.updateMessageCount.run(userPhone);
}

/**
 * Get the last N messages for a user, returned in chronological order.
 */
export function getHistory(userPhone, limit = 20) {
  const rows = stmts.getHistory.all(userPhone, limit);
  return rows.reverse();
}

/**
 * Update the user's display name.
 */
export function updateUserName(phone, name) {
  stmts.updateUserName.run(name, phone);
}

// ── Message Counting ────────────────────────────────────────────────

/**
 * Get total lifetime messages used by a user (across all days).
 */
export function getTotalMessagesUsed(phone) {
  const row = stmts.getTotalUsage.get(phone);
  return row ? row.total : 0;
}

/**
 * Increment the daily message count for a user.
 */
export function incrementMessageCount(phone) {
  const today = new Date().toISOString().slice(0, 10);
  stmts.upsertDailyUsage.run(phone, today);
}

// ── Cost Logging ────────────────────────────────────────────────────

/**
 * Log estimated cost for a conversation turn.
 */
export function logConversationCost(phone, durationMs, estimatedCost = 0.003, model = 'unknown') {
  stmts.logCost.run(phone, durationMs, estimatedCost, model);
}

// ── Job State Management ────────────────────────────────────────────

/**
 * Create a new job for a user.
 */
export function createJob(userPhone, tier, description, priceMxn) {
  const result = stmts.createJob.run(userPhone, 'quoted', tier, description, priceMxn);
  return { id: result.lastInsertRowid, status: 'quoted', tier, description, quoted_price_mxn: priceMxn };
}

/**
 * Get the active job for a user (quoted, confirmed, or in_progress).
 */
export function getActiveJob(userPhone) {
  return stmts.getActiveJob.get(userPhone) || null;
}

/**
 * Get the pending quote for a user (status = 'quoted').
 */
export function getPendingQuote(userPhone) {
  return stmts.getPendingQuote.get(userPhone) || null;
}

/**
 * Get the in-progress job for a user.
 */
export function getInProgressJob(userPhone) {
  return stmts.getInProgressJob.get(userPhone) || null;
}

/**
 * Update a job's status.
 */
export function updateJobStatus(jobId, newStatus) {
  stmts.updateJobStatus.run(newStatus, jobId);
}

/**
 * Add tokens used to a job's running total.
 */
export function addJobTokens(jobId, tokens) {
  stmts.updateJobTokens.run(tokens, jobId);
}

// ── Conversation State ───────────────────────────────────────────────

/**
 * Update a user's conversation state.
 */
export function updateConversationState(phone, state) {
  stmts.updateConversationState.run(state, phone);
}

/**
 * Update the last detected service category for a user.
 */
export function updateLastServiceDetected(phone, category) {
  stmts.updateLastServiceDetected.run(category, phone);
}

// ── Deliverables ────────────────────────────────────────────────────

/**
 * Create a new deliverable quote.
 */
export function createDeliverable(userPhone, category, description, scopeSummary, priceMxn) {
  const result = stmts.createDeliverable.run(userPhone, category, description, scopeSummary, priceMxn);
  return { id: result.lastInsertRowid, status: 'quoted', category, description, price_mxn: priceMxn };
}

/**
 * Get the pending (quoted) deliverable for a user.
 */
export function getPendingDeliverable(userPhone) {
  return stmts.getPendingDeliverable.get(userPhone) || null;
}

/**
 * Get the active deliverable for a user.
 */
export function getActiveDeliverable(userPhone) {
  return stmts.getActiveDeliverable.get(userPhone) || null;
}

/**
 * Update a deliverable's status.
 */
export function updateDeliverableStatus(deliverableId, newStatus) {
  stmts.updateDeliverableStatus.run(newStatus, deliverableId);
}

/**
 * Mark a deliverable as paid.
 */
export function markDeliverablePaid(deliverableId, mercadopagoId) {
  stmts.updateDeliverablePaid.run(mercadopagoId, deliverableId);
}

/**
 * Mark a deliverable as delivered.
 */
export function markDeliverableDelivered(deliverableId) {
  stmts.updateDeliverableDelivered.run(deliverableId);
}

// ── v3: User Profiles ────────────────────────────────────────────────

/**
 * Get the user profile for a phone number.
 * Returns parsed profile object, or empty object if none exists.
 */
export function getUserProfile(phone) {
  const row = stmts.getProfile.get(phone);
  if (!row) return {};
  try {
    return JSON.parse(row.profile_json);
  } catch {
    return {};
  }
}

/**
 * Save/update a user profile.
 */
export function saveUserProfile(phone, profileObj) {
  stmts.upsertProfile.run(phone, JSON.stringify(profileObj));
}

// ── v3: Projects ─────────────────────────────────────────────────────

/**
 * Create a new project.
 */
export function createProject(phone, projectType, projectName, contextObj = {}) {
  const result = stmts.createProject.run(phone, projectType, projectName, JSON.stringify(contextObj));
  return { id: result.lastInsertRowid, project_type: projectType, project_name: projectName, status: 'active' };
}

/**
 * Get active projects for a user.
 */
export function getActiveProjects(phone) {
  const rows = stmts.getActiveProjects.all(phone);
  return rows.map(r => ({
    ...r,
    context: (() => { try { return JSON.parse(r.context_json); } catch { return {}; } })(),
  }));
}

/**
 * Get a project by ID.
 */
export function getProjectById(id) {
  const row = stmts.getProjectById.get(id);
  if (!row) return null;
  try { row.context = JSON.parse(row.context_json); } catch { row.context = {}; }
  return row;
}

/**
 * Update a project's context JSON.
 */
export function updateProjectContext(projectId, contextObj) {
  stmts.updateProjectContext.run(JSON.stringify(contextObj), projectId);
}

/**
 * Update a project's status.
 */
export function updateProjectStatus(projectId, status) {
  stmts.updateProjectStatus.run(status, projectId);
}

/**
 * Add consumed credits to a project.
 */
export function addProjectCredits(projectId, amount) {
  stmts.addProjectCredits.run(amount, projectId);
}

// ── v3: Credit System ────────────────────────────────────────────────

/**
 * Get credit balance record for a phone.
 */
export function getCreditBalance(phone) {
  return stmts.getCreditBalance.get(phone) || null;
}

/**
 * Upsert credit balance.
 */
export function upsertCreditBalance(phone, balance, totalPurchased, totalConsumed, lastPurchaseAmount, lastPurchaseDate) {
  stmts.upsertCreditBalance.run(phone, balance, totalPurchased, totalConsumed, lastPurchaseAmount, lastPurchaseDate);
}

/**
 * Insert a credit transaction.
 */
export function insertCreditTransaction(phone, amount, type, description, balanceAfter, referenceId = null, metadataJson = null, projectId = null) {
  stmts.insertCreditTx.run(phone, amount, type, description, balanceAfter, referenceId, metadataJson, projectId);
}

/**
 * Get credit transaction history.
 */
export function getCreditTransactionHistory(phone, limit = 20) {
  return stmts.getCreditTxHistory.all(phone, limit);
}

/**
 * Get the total message count for a user (from users table).
 */
export function getUserMessageCount(phone) {
  const user = stmts.getUser.get(phone);
  return user ? (user.total_messages || 0) : 0;
}

export default db;
