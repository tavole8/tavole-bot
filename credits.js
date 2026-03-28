/**
 * Tavole v3 — Credit system module.
 *
 * Manages credit balances, purchases, consumption, and transaction history.
 * Credits are integer-based (1 credit ≈ $1 MXN at Starter tier).
 */

import {
  getCreditBalance,
  upsertCreditBalance,
  insertCreditTransaction,
  getCreditTransactionHistory,
  addProjectCredits,
} from './db.js';

// Credit packages available for purchase
export const CREDIT_PACKAGES = {
  starter: { name: 'Starter', price_mxn: 100, credits: 100, bonus: 0 },
  plus:    { name: 'Plus',    price_mxn: 300, credits: 350, bonus: 50 },
  pro:     { name: 'Pro',     price_mxn: 500, credits: 650, bonus: 150 },
};

// Threshold for silent consumption (anything above requires a quote)
export const SILENT_CONSUMPTION_LIMIT = 20;

/**
 * Get the current credit balance for a user.
 * Returns 0 if user has no credit record.
 */
export function getBalance(phone) {
  const record = getCreditBalance(phone);
  return record ? record.balance : 0;
}

/**
 * Get the full credit balance record.
 */
export function getBalanceRecord(phone) {
  return getCreditBalance(phone);
}

/**
 * Add credits to a user's balance (for purchases).
 * Returns the new balance.
 */
export function addCredits(phone, amount, description = 'Recarga de creditos', referenceId = null, metadata = null) {
  const record = getCreditBalance(phone) || {
    balance: 0, total_purchased: 0, total_consumed: 0,
    last_purchase_amount: null, last_purchase_date: null,
  };

  const newBalance = record.balance + amount;
  const newTotalPurchased = record.total_purchased + amount;
  const now = new Date().toISOString();

  upsertCreditBalance(
    phone, newBalance, newTotalPurchased, record.total_consumed,
    amount, now
  );

  insertCreditTransaction(
    phone, amount, 'purchase', description, newBalance,
    referenceId, metadata ? JSON.stringify(metadata) : null, null
  );

  return newBalance;
}

/**
 * Consume credits from a user's balance.
 * Returns { success: boolean, newBalance: number, warning: string|null }.
 *
 * If insufficient balance, returns success=false without deducting.
 */
export function consumeCredits(phone, amount, description = 'Uso de creditos', projectId = null, referenceId = null) {
  const record = getCreditBalance(phone);
  if (!record || record.balance < amount) {
    return {
      success: false,
      newBalance: record ? record.balance : 0,
      warning: 'insufficient_balance',
    };
  }

  const newBalance = record.balance - amount;
  const newTotalConsumed = record.total_consumed + amount;

  upsertCreditBalance(
    phone, newBalance, record.total_purchased, newTotalConsumed,
    record.last_purchase_amount, record.last_purchase_date
  );

  insertCreditTransaction(
    phone, -amount, 'consumption', description, newBalance,
    referenceId, null, projectId
  );

  // Track credits on project if applicable
  if (projectId) {
    addProjectCredits(projectId, amount);
  }

  // Check for low balance warning
  const warning = checkLowBalance(phone, newBalance, record.last_purchase_amount);

  return { success: true, newBalance, warning };
}

/**
 * Add bonus credits (e.g., from package bonuses or promotions).
 */
export function addBonusCredits(phone, amount, description = 'Creditos de bono') {
  const record = getCreditBalance(phone) || {
    balance: 0, total_purchased: 0, total_consumed: 0,
    last_purchase_amount: null, last_purchase_date: null,
  };

  const newBalance = record.balance + amount;

  upsertCreditBalance(
    phone, newBalance, record.total_purchased, record.total_consumed,
    record.last_purchase_amount, record.last_purchase_date
  );

  insertCreditTransaction(
    phone, amount, 'bonus', description, newBalance,
    null, null, null
  );

  return newBalance;
}

/**
 * Refund credits to a user.
 */
export function refundCredits(phone, amount, description = 'Reembolso', referenceId = null) {
  const record = getCreditBalance(phone) || {
    balance: 0, total_purchased: 0, total_consumed: 0,
    last_purchase_amount: null, last_purchase_date: null,
  };

  const newBalance = record.balance + amount;
  // Reduce total_consumed since we're refunding
  const newTotalConsumed = Math.max(0, record.total_consumed - amount);

  upsertCreditBalance(
    phone, newBalance, record.total_purchased, newTotalConsumed,
    record.last_purchase_amount, record.last_purchase_date
  );

  insertCreditTransaction(
    phone, amount, 'refund', description, newBalance,
    referenceId, null, null
  );

  return newBalance;
}

/**
 * Get transaction history for a user.
 */
export function getTransactionHistory(phone, limit = 20) {
  return getCreditTransactionHistory(phone, limit);
}

/**
 * Check if the user's balance is below the low-balance threshold.
 * Threshold = 20% of last purchase amount.
 * Returns null if OK, or a warning string.
 */
export function checkLowBalance(phone, currentBalance = null, lastPurchaseAmount = null) {
  if (currentBalance === null || lastPurchaseAmount === null) {
    const record = getCreditBalance(phone);
    if (!record) return null;
    currentBalance = record.balance;
    lastPurchaseAmount = record.last_purchase_amount;
  }

  if (!lastPurchaseAmount || lastPurchaseAmount === 0) return null;

  const threshold = Math.ceil(lastPurchaseAmount * 0.2);
  if (currentBalance <= threshold && currentBalance > 0) {
    return 'low_balance';
  }
  if (currentBalance <= 0) {
    return 'zero_balance';
  }
  return null;
}

/**
 * Format a balance summary message in Spanish.
 */
export function formatBalanceSummary(phone) {
  const record = getCreditBalance(phone);
  if (!record || record.balance === 0) {
    return 'No tienes creditos. Puedes recargar cuando quieras.';
  }

  const lastTx = getCreditTransactionHistory(phone, 1);
  let msg = `Tienes ${record.balance} creditos.`;

  if (lastTx.length > 0 && lastTx[0].type === 'consumption') {
    msg += ` Tu ultimo uso: ${Math.abs(lastTx[0].amount)} creditos (${lastTx[0].description}).`;
  }

  return msg;
}

/**
 * Format credit packages for display in WhatsApp.
 */
export function formatCreditPackages() {
  return `Tenemos tres opciones:\n\n` +
    `Starter, $100 MXN, 100 creditos\n` +
    `Plus, $300 MXN, 350 creditos (17% extra)\n` +
    `Pro, $500 MXN, 650 creditos (30% extra)\n\n` +
    `Cual te interesa?`;
}

/**
 * Format transaction history for display.
 */
export function formatTransactionHistory(phone, limit = 10) {
  const txs = getCreditTransactionHistory(phone, limit);
  if (txs.length === 0) {
    return 'No tienes transacciones todavia.';
  }

  const lines = txs.map(tx => {
    const date = tx.created_at.slice(0, 10);
    const sign = tx.amount >= 0 ? '+' : '';
    return `${date}: ${sign}${tx.amount} creditos, ${tx.description}`;
  });

  const record = getCreditBalance(phone);
  const balance = record ? record.balance : 0;

  return `Historial de creditos:\n\n${lines.join('\n')}\n\nSaldo actual: ${balance} creditos`;
}
