import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import config from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Use /tmp on Railway (writable), local data/ dir otherwise
const isRailway = !!process.env.RAILWAY_ENVIRONMENT;
const dataDir = isRailway ? '/tmp/tavole-data' : join(__dirname, 'data');
mkdirSync(dataDir, { recursive: true });
const DB_PATH = join(dataDir, 'conversations.db');

let db = null;
let stmts = null;
let useMemoryFallback = false;

// ══════════════════════════════════════════════════════════════════════
// IN-MEMORY FALLBACK STORE (when better-sqlite3 fails on Railway)
// ══════════════════════════════════════════════════════════════════════

const memStore = {
  users: new Map(),          // phone -> user object
  messages: new Map(),       // phone -> [{id, role, content, timestamp}]
  dailyUsage: new Map(),     // "phone|date" -> count
  costs: [],
  jobs: new Map(),           // id -> job object
  jobCounter: 0,
  userCredits: new Map(),    // phone -> credit obj
  creditTxs: new Map(),      // phone -> [tx, ...]
  deliverables: new Map(),   // id -> deliverable
  deliverableCounter: 0,
  userProfiles: new Map(),   // phone -> profile obj
  projects: new Map(),       // id -> project
  projectCounter: 0,
  creditBalances: new Map(), // phone -> balance obj
  creditTxsV3: new Map(),   // phone -> [tx, ...]
  msgCounter: 0,
};

function nowISO() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ══════════════════════════════════════════════════════════════════════
// TRY SQLITE FIRST
// ══════════════════════════════════════════════════════════════════════

try {
  const Database = (await import('better-sqlite3')).default;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Create all tables
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
    CREATE TABLE IF NOT EXISTS user_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_phone TEXT UNIQUE NOT NULL,
      profile_json TEXT DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now'))
    );
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

  // Migrations
  try { db.prepare("SELECT model FROM conversation_costs LIMIT 1").get(); } catch { db.exec("ALTER TABLE conversation_costs ADD COLUMN model TEXT DEFAULT 'unknown'"); }
  try { db.prepare("SELECT conversation_state FROM users LIMIT 1").get(); } catch { db.exec("ALTER TABLE users ADD COLUMN conversation_state TEXT DEFAULT 'chatting'"); }
  try { db.prepare("SELECT last_service_detected FROM users LIMIT 1").get(); } catch { db.exec("ALTER TABLE users ADD COLUMN last_service_detected TEXT"); }

  // Prepared statements
  stmts = {
    getUser: db.prepare('SELECT * FROM users WHERE phone = ?'),
    createUser: db.prepare('INSERT OR IGNORE INTO users (phone) VALUES (?)'),
    updateMessageCount: db.prepare('UPDATE users SET total_messages = total_messages + 1 WHERE phone = ?'),
    updateUserName: db.prepare('UPDATE users SET name = ? WHERE phone = ?'),
    saveMessage: db.prepare('INSERT INTO messages (user_phone, role, content) VALUES (?, ?, ?)'),
    getHistory: db.prepare('SELECT role, content FROM messages WHERE user_phone = ? ORDER BY id DESC LIMIT ?'),
    getTotalUsage: db.prepare('SELECT COALESCE(SUM(message_count), 0) AS total FROM daily_usage WHERE user_phone = ?'),
    getDailyUsage: db.prepare('SELECT message_count FROM daily_usage WHERE user_phone = ? AND date = ?'),
    upsertDailyUsage: db.prepare(`
      INSERT INTO daily_usage (user_phone, date, message_count) VALUES (?, ?, 1)
      ON CONFLICT(user_phone, date) DO UPDATE SET message_count = message_count + 1
    `),
    logCost: db.prepare('INSERT INTO conversation_costs (user_phone, duration_ms, estimated_cost_usd, model) VALUES (?, ?, ?, ?)'),
    createJob: db.prepare('INSERT INTO job_states (user_phone, status, tier, description, quoted_price_mxn) VALUES (?, ?, ?, ?, ?)'),
    getActiveJob: db.prepare("SELECT * FROM job_states WHERE user_phone = ? AND status IN ('quoted', 'confirmed', 'in_progress') ORDER BY id DESC LIMIT 1"),
    getPendingQuote: db.prepare("SELECT * FROM job_states WHERE user_phone = ? AND status = 'quoted' ORDER BY id DESC LIMIT 1"),
    getInProgressJob: db.prepare("SELECT * FROM job_states WHERE user_phone = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1"),
    updateJobStatus: db.prepare("UPDATE job_states SET status = ?, updated_at = datetime('now') WHERE id = ?"),
    updateJobTokens: db.prepare("UPDATE job_states SET tokens_used = tokens_used + ?, updated_at = datetime('now') WHERE id = ?"),
    updateConversationState: db.prepare("UPDATE users SET conversation_state = ? WHERE phone = ?"),
    updateLastServiceDetected: db.prepare("UPDATE users SET last_service_detected = ? WHERE phone = ?"),
    getProfile: db.prepare('SELECT * FROM user_profiles WHERE user_phone = ?'),
    upsertProfile: db.prepare(`
      INSERT INTO user_profiles (user_phone, profile_json, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(user_phone) DO UPDATE SET profile_json = excluded.profile_json, updated_at = datetime('now')
    `),
    createProject: db.prepare('INSERT INTO projects (user_phone, project_type, project_name, context_json) VALUES (?, ?, ?, ?)'),
    getActiveProjects: db.prepare("SELECT * FROM projects WHERE user_phone = ? AND status = 'active' ORDER BY updated_at DESC"),
    getProjectById: db.prepare('SELECT * FROM projects WHERE id = ?'),
    updateProjectContext: db.prepare("UPDATE projects SET context_json = ?, updated_at = datetime('now') WHERE id = ?"),
    updateProjectStatus: db.prepare("UPDATE projects SET status = ?, updated_at = datetime('now') WHERE id = ?"),
    addProjectCredits: db.prepare("UPDATE projects SET credits_consumed = credits_consumed + ?, updated_at = datetime('now') WHERE id = ?"),
    getCreditBalance: db.prepare('SELECT * FROM credit_balances WHERE user_phone = ?'),
    upsertCreditBalance: db.prepare(`
      INSERT INTO credit_balances (user_phone, balance, total_purchased, total_consumed, last_purchase_amount, last_purchase_date, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_phone) DO UPDATE SET balance = excluded.balance, total_purchased = excluded.total_purchased,
        total_consumed = excluded.total_consumed, last_purchase_amount = excluded.last_purchase_amount,
        last_purchase_date = excluded.last_purchase_date, updated_at = datetime('now')
    `),
    insertCreditTx: db.prepare(`
      INSERT INTO credit_transactions_v3 (user_phone, amount, type, description, balance_after, reference_id, metadata_json, project_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getCreditTxHistory: db.prepare('SELECT * FROM credit_transactions_v3 WHERE user_phone = ? ORDER BY created_at DESC LIMIT ?'),
    createDeliverable: db.prepare('INSERT INTO deliverables (user_phone, category, description, scope_summary, price_mxn) VALUES (?, ?, ?, ?, ?)'),
    getPendingDeliverable: db.prepare("SELECT * FROM deliverables WHERE user_phone = ? AND status = 'quoted' ORDER BY id DESC LIMIT 1"),
    getActiveDeliverable: db.prepare("SELECT * FROM deliverables WHERE user_phone = ? AND status IN ('quoted', 'paid', 'in_progress') ORDER BY id DESC LIMIT 1"),
    updateDeliverableStatus: db.prepare("UPDATE deliverables SET status = ? WHERE id = ?"),
    updateDeliverablePaid: db.prepare("UPDATE deliverables SET status = 'paid', mercadopago_id = ?, paid_at = datetime('now') WHERE id = ?"),
    updateDeliverableDelivered: db.prepare("UPDATE deliverables SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?"),
  };

  console.log('[DB] SQLite initialized successfully at', DB_PATH);
} catch (err) {
  console.warn('[DB] SQLite failed, using in-memory fallback:', err.message);
  useMemoryFallback = true;
}

// ══════════════════════════════════════════════════════════════════════
// EXPORTED FUNCTIONS — same signatures regardless of backend
// ══════════════════════════════════════════════════════════════════════

// ── User Management ─────────────────────────────────────────────────

export function getOrCreateUser(phone) {
  if (!useMemoryFallback) {
    const existing = stmts.getUser.get(phone);
    if (existing) return { user: existing, isNew: false };
    stmts.createUser.run(phone);
    const user = stmts.getUser.get(phone);
    return { user, isNew: true };
  }
  // Memory fallback
  if (memStore.users.has(phone)) {
    return { user: memStore.users.get(phone), isNew: false };
  }
  const user = {
    phone,
    name: null,
    language: 'es',
    conversation_state: 'chatting',
    last_service_detected: null,
    created_at: nowISO(),
    total_messages: 0,
  };
  memStore.users.set(phone, user);
  return { user, isNew: true };
}

export function saveMessage(userPhone, role, content) {
  if (!useMemoryFallback) {
    stmts.saveMessage.run(userPhone, role, content);
    stmts.updateMessageCount.run(userPhone);
    return;
  }
  if (!memStore.messages.has(userPhone)) memStore.messages.set(userPhone, []);
  memStore.msgCounter++;
  memStore.messages.get(userPhone).push({
    id: memStore.msgCounter,
    role,
    content,
    timestamp: nowISO(),
  });
  const u = memStore.users.get(userPhone);
  if (u) u.total_messages = (u.total_messages || 0) + 1;
}

export function getHistory(userPhone, limit = 20) {
  if (!useMemoryFallback) {
    const rows = stmts.getHistory.all(userPhone, limit);
    return rows.reverse();
  }
  const msgs = memStore.messages.get(userPhone) || [];
  return msgs.slice(-limit).map(m => ({ role: m.role, content: m.content }));
}

export function updateUserName(phone, name) {
  if (!useMemoryFallback) {
    stmts.updateUserName.run(name, phone);
    return;
  }
  const u = memStore.users.get(phone);
  if (u) u.name = name;
}

// ── Message Counting ────────────────────────────────────────────────

export function getTotalMessagesUsed(phone) {
  if (!useMemoryFallback) {
    const row = stmts.getTotalUsage.get(phone);
    return row ? row.total : 0;
  }
  let total = 0;
  for (const [key, count] of memStore.dailyUsage) {
    if (key.startsWith(phone + '|')) total += count;
  }
  return total;
}

export function incrementMessageCount(phone) {
  const today = new Date().toISOString().slice(0, 10);
  if (!useMemoryFallback) {
    stmts.upsertDailyUsage.run(phone, today);
    return;
  }
  const key = `${phone}|${today}`;
  memStore.dailyUsage.set(key, (memStore.dailyUsage.get(key) || 0) + 1);
}

// ── Cost Logging ────────────────────────────────────────────────────

export function logConversationCost(phone, durationMs, estimatedCost = 0.003, model = 'unknown') {
  if (!useMemoryFallback) {
    stmts.logCost.run(phone, durationMs, estimatedCost, model);
    return;
  }
  memStore.costs.push({ user_phone: phone, duration_ms: durationMs, estimated_cost_usd: estimatedCost, model, timestamp: nowISO() });
}

// ── Job State Management ────────────────────────────────────────────

export function createJob(userPhone, tier, description, priceMxn) {
  if (!useMemoryFallback) {
    const result = stmts.createJob.run(userPhone, 'quoted', tier, description, priceMxn);
    return { id: result.lastInsertRowid, status: 'quoted', tier, description, quoted_price_mxn: priceMxn };
  }
  memStore.jobCounter++;
  const job = {
    id: memStore.jobCounter,
    user_phone: userPhone,
    status: 'quoted',
    tier,
    description,
    quoted_price_mxn: priceMxn,
    tokens_used: 0,
    created_at: nowISO(),
    updated_at: nowISO(),
  };
  memStore.jobs.set(job.id, job);
  return { id: job.id, status: 'quoted', tier, description, quoted_price_mxn: priceMxn };
}

export function getActiveJob(userPhone) {
  if (!useMemoryFallback) return stmts.getActiveJob.get(userPhone) || null;
  for (const job of [...memStore.jobs.values()].reverse()) {
    if (job.user_phone === userPhone && ['quoted', 'confirmed', 'in_progress'].includes(job.status)) return job;
  }
  return null;
}

export function getPendingQuote(userPhone) {
  if (!useMemoryFallback) return stmts.getPendingQuote.get(userPhone) || null;
  for (const job of [...memStore.jobs.values()].reverse()) {
    if (job.user_phone === userPhone && job.status === 'quoted') return job;
  }
  return null;
}

export function getInProgressJob(userPhone) {
  if (!useMemoryFallback) return stmts.getInProgressJob.get(userPhone) || null;
  for (const job of [...memStore.jobs.values()].reverse()) {
    if (job.user_phone === userPhone && job.status === 'in_progress') return job;
  }
  return null;
}

export function updateJobStatus(jobId, newStatus) {
  if (!useMemoryFallback) { stmts.updateJobStatus.run(newStatus, jobId); return; }
  const job = memStore.jobs.get(jobId);
  if (job) { job.status = newStatus; job.updated_at = nowISO(); }
}

export function addJobTokens(jobId, tokens) {
  if (!useMemoryFallback) { stmts.updateJobTokens.run(tokens, jobId); return; }
  const job = memStore.jobs.get(jobId);
  if (job) { job.tokens_used = (job.tokens_used || 0) + tokens; job.updated_at = nowISO(); }
}

// ── Conversation State ───────────────────────────────────────────────

export function updateConversationState(phone, state) {
  if (!useMemoryFallback) { stmts.updateConversationState.run(state, phone); return; }
  const u = memStore.users.get(phone);
  if (u) u.conversation_state = state;
}

export function updateLastServiceDetected(phone, category) {
  if (!useMemoryFallback) { stmts.updateLastServiceDetected.run(category, phone); return; }
  const u = memStore.users.get(phone);
  if (u) u.last_service_detected = category;
}

// ── Deliverables ────────────────────────────────────────────────────

export function createDeliverable(userPhone, category, description, scopeSummary, priceMxn) {
  if (!useMemoryFallback) {
    const result = stmts.createDeliverable.run(userPhone, category, description, scopeSummary, priceMxn);
    return { id: result.lastInsertRowid, status: 'quoted', category, description, price_mxn: priceMxn };
  }
  memStore.deliverableCounter++;
  const d = {
    id: memStore.deliverableCounter,
    user_phone: userPhone,
    category,
    description,
    scope_summary: scopeSummary,
    price_mxn: priceMxn,
    status: 'quoted',
    mercadopago_id: null,
    quoted_at: nowISO(),
    paid_at: null,
    delivered_at: null,
  };
  memStore.deliverables.set(d.id, d);
  return { id: d.id, status: 'quoted', category, description, price_mxn: priceMxn };
}

export function getPendingDeliverable(userPhone) {
  if (!useMemoryFallback) return stmts.getPendingDeliverable.get(userPhone) || null;
  for (const d of [...memStore.deliverables.values()].reverse()) {
    if (d.user_phone === userPhone && d.status === 'quoted') return d;
  }
  return null;
}

export function getActiveDeliverable(userPhone) {
  if (!useMemoryFallback) return stmts.getActiveDeliverable.get(userPhone) || null;
  for (const d of [...memStore.deliverables.values()].reverse()) {
    if (d.user_phone === userPhone && ['quoted', 'paid', 'in_progress'].includes(d.status)) return d;
  }
  return null;
}

export function updateDeliverableStatus(deliverableId, newStatus) {
  if (!useMemoryFallback) { stmts.updateDeliverableStatus.run(newStatus, deliverableId); return; }
  const d = memStore.deliverables.get(deliverableId);
  if (d) d.status = newStatus;
}

export function markDeliverablePaid(deliverableId, mercadopagoId) {
  if (!useMemoryFallback) { stmts.updateDeliverablePaid.run(mercadopagoId, deliverableId); return; }
  const d = memStore.deliverables.get(deliverableId);
  if (d) { d.status = 'paid'; d.mercadopago_id = mercadopagoId; d.paid_at = nowISO(); }
}

export function markDeliverableDelivered(deliverableId) {
  if (!useMemoryFallback) { stmts.updateDeliverableDelivered.run(deliverableId); return; }
  const d = memStore.deliverables.get(deliverableId);
  if (d) { d.status = 'delivered'; d.delivered_at = nowISO(); }
}

// ── v3: User Profiles ────────────────────────────────────────────────

export function getUserProfile(phone) {
  if (!useMemoryFallback) {
    const row = stmts.getProfile.get(phone);
    if (!row) return {};
    try { return JSON.parse(row.profile_json); } catch { return {}; }
  }
  return memStore.userProfiles.get(phone) || {};
}

export function saveUserProfile(phone, profileObj) {
  if (!useMemoryFallback) { stmts.upsertProfile.run(phone, JSON.stringify(profileObj)); return; }
  memStore.userProfiles.set(phone, profileObj);
}

// ── v3: Projects ─────────────────────────────────────────────────────

export function createProject(phone, projectType, projectName, contextObj = {}) {
  if (!useMemoryFallback) {
    const result = stmts.createProject.run(phone, projectType, projectName, JSON.stringify(contextObj));
    return { id: result.lastInsertRowid, project_type: projectType, project_name: projectName, status: 'active' };
  }
  memStore.projectCounter++;
  const p = {
    id: memStore.projectCounter,
    user_phone: phone,
    project_type: projectType,
    project_name: projectName,
    context_json: JSON.stringify(contextObj),
    context: contextObj,
    status: 'active',
    credits_consumed: 0,
    created_at: nowISO(),
    updated_at: nowISO(),
  };
  memStore.projects.set(p.id, p);
  return { id: p.id, project_type: projectType, project_name: projectName, status: 'active' };
}

export function getActiveProjects(phone) {
  if (!useMemoryFallback) {
    const rows = stmts.getActiveProjects.all(phone);
    return rows.map(r => ({
      ...r,
      context: (() => { try { return JSON.parse(r.context_json); } catch { return {}; } })(),
    }));
  }
  return [...memStore.projects.values()]
    .filter(p => p.user_phone === phone && p.status === 'active')
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map(p => ({
      ...p,
      context: typeof p.context === 'object' ? p.context : (() => { try { return JSON.parse(p.context_json); } catch { return {}; } })(),
    }));
}

export function getProjectById(id) {
  if (!useMemoryFallback) {
    const row = stmts.getProjectById.get(id);
    if (!row) return null;
    try { row.context = JSON.parse(row.context_json); } catch { row.context = {}; }
    return row;
  }
  return memStore.projects.get(id) || null;
}

export function updateProjectContext(projectId, contextObj) {
  if (!useMemoryFallback) { stmts.updateProjectContext.run(JSON.stringify(contextObj), projectId); return; }
  const p = memStore.projects.get(projectId);
  if (p) { p.context_json = JSON.stringify(contextObj); p.context = contextObj; p.updated_at = nowISO(); }
}

export function updateProjectStatus(projectId, status) {
  if (!useMemoryFallback) { stmts.updateProjectStatus.run(status, projectId); return; }
  const p = memStore.projects.get(projectId);
  if (p) { p.status = status; p.updated_at = nowISO(); }
}

export function addProjectCredits(projectId, amount) {
  if (!useMemoryFallback) { stmts.addProjectCredits.run(amount, projectId); return; }
  const p = memStore.projects.get(projectId);
  if (p) { p.credits_consumed = (p.credits_consumed || 0) + amount; p.updated_at = nowISO(); }
}

// ── v3: Credit System ────────────────────────────────────────────────

export function getCreditBalance(phone) {
  if (!useMemoryFallback) return stmts.getCreditBalance.get(phone) || null;
  return memStore.creditBalances.get(phone) || null;
}

export function upsertCreditBalance(phone, balance, totalPurchased, totalConsumed, lastPurchaseAmount, lastPurchaseDate) {
  if (!useMemoryFallback) {
    stmts.upsertCreditBalance.run(phone, balance, totalPurchased, totalConsumed, lastPurchaseAmount, lastPurchaseDate);
    return;
  }
  memStore.creditBalances.set(phone, {
    user_phone: phone,
    balance,
    total_purchased: totalPurchased,
    total_consumed: totalConsumed,
    last_purchase_amount: lastPurchaseAmount,
    last_purchase_date: lastPurchaseDate,
    updated_at: nowISO(),
  });
}

export function insertCreditTransaction(phone, amount, type, description, balanceAfter, referenceId = null, metadataJson = null, projectId = null) {
  if (!useMemoryFallback) {
    stmts.insertCreditTx.run(phone, amount, type, description, balanceAfter, referenceId, metadataJson, projectId);
    return;
  }
  if (!memStore.creditTxsV3.has(phone)) memStore.creditTxsV3.set(phone, []);
  memStore.creditTxsV3.get(phone).push({
    user_phone: phone,
    amount,
    type,
    description,
    balance_after: balanceAfter,
    reference_id: referenceId,
    metadata_json: metadataJson,
    project_id: projectId,
    created_at: nowISO(),
  });
}

export function getCreditTransactionHistory(phone, limit = 20) {
  if (!useMemoryFallback) return stmts.getCreditTxHistory.all(phone, limit);
  const txs = memStore.creditTxsV3.get(phone) || [];
  return txs.slice(-limit).reverse();
}

export function getUserMessageCount(phone) {
  if (!useMemoryFallback) {
    const user = stmts.getUser.get(phone);
    return user ? (user.total_messages || 0) : 0;
  }
  const u = memStore.users.get(phone);
  return u ? (u.total_messages || 0) : 0;
}

// ── Export info about which backend is active ────────────────────────

export function getDbBackend() {
  return useMemoryFallback ? 'memory' : 'sqlite';
}

export default db;
