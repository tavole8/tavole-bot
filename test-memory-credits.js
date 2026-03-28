/**
 * Tavole v3 — Memory system & credit system tests (offline, no API calls needed).
 *
 * Tests: credit operations, profile storage, project management, intent detection.
 * Run: node test-memory-credits.js
 */

import {
  getOrCreateUser,
  saveMessage,
  getHistory,
  getUserProfile,
  saveUserProfile,
  getActiveProjects,
  createProject,
  getProjectById,
  updateProjectContext,
  updateProjectStatus,
  addProjectCredits,
  getCreditBalance,
  getUserMessageCount,
  incrementMessageCount,
} from './db.js';

import {
  getBalance,
  getBalanceRecord,
  addCredits,
  consumeCredits,
  addBonusCredits,
  refundCredits,
  getTransactionHistory,
  checkLowBalance,
  formatBalanceSummary,
  formatCreditPackages,
  formatTransactionHistory,
  CREDIT_PACKAGES,
  SILENT_CONSUMPTION_LIMIT,
} from './credits.js';

import { shouldUpdateProfile, buildMemoryContext } from './memory.js';

import { parseActionType, detectCreditIntent, handleCreditIntent } from './ai.js';

const TEST_PHONE = 'test_memory_credits_' + Date.now();
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

// ── 1. Credit System — Balance Operations ──────────────────────────
console.log('\n💰 1. Credit System — Balance Operations');

assert(getBalance(TEST_PHONE) === 0, 'New user has 0 credits');

const balanceAfterPurchase = addCredits(TEST_PHONE, 350, 'Recarga Plus (350 creditos)', 'mp_pay_001');
assert(balanceAfterPurchase === 350, 'After purchasing 350, balance is 350');

const record = getBalanceRecord(TEST_PHONE);
assert(record !== null, 'Balance record exists');
assert(record.total_purchased === 350, 'Total purchased is 350');
assert(record.last_purchase_amount === 350, 'Last purchase amount is 350');

// ── 2. Credit System — Consumption ─────────────────────────────────
console.log('\n🔥 2. Credit System — Consumption');

const consume1 = consumeCredits(TEST_PHONE, 5, 'Resultado de laboratorio', null);
assert(consume1.success === true, 'Consumption of 5 credits succeeds');
assert(consume1.newBalance === 345, 'Balance after consuming 5 is 345');

const consume2 = consumeCredits(TEST_PHONE, 500, 'Too expensive action');
assert(consume2.success === false, 'Consumption exceeding balance fails');
assert(consume2.warning === 'insufficient_balance', 'Warning is insufficient_balance');

// Consume down to near low-balance threshold (20% of 350 = 70)
const consume3 = consumeCredits(TEST_PHONE, 280, 'Big action');
assert(consume3.success === true, 'Consumption of 280 succeeds');
assert(consume3.newBalance === 65, 'Balance after big action is 65');
assert(consume3.warning === 'low_balance', 'Low balance warning triggered at 65 (threshold 70)');

// ── 3. Credit System — Bonus & Refund ──────────────────────────────
console.log('\n🎁 3. Credit System — Bonus & Refund');

const bonusBalance = addBonusCredits(TEST_PHONE, 50, 'Bono de bienvenida');
assert(bonusBalance === 115, 'Balance after 50 bonus is 115');

const refundBalance = refundCredits(TEST_PHONE, 20, 'Reembolso parcial', 'ref_001');
assert(refundBalance === 135, 'Balance after 20 refund is 135');

// ── 4. Credit System — Transaction History ─────────────────────────
console.log('\n📜 4. Credit System — Transaction History');

const txHistory = getTransactionHistory(TEST_PHONE, 10);
assert(txHistory.length >= 5, `Transaction history has ${txHistory.length} entries (expected ≥5)`);
assert(['refund', 'consumption', 'purchase', 'bonus'].includes(txHistory[0].type), 'Most recent transaction has valid type');

// Check balance_after is tracked
const purchaseTx = txHistory.find(t => t.type === 'purchase');
assert(purchaseTx !== undefined, 'Found purchase transaction');
assert(purchaseTx.balance_after === 350, 'Purchase tx has correct balance_after');

// ── 5. Credit System — Low Balance Check ───────────────────────────
console.log('\n⚠️ 5. Credit System — Low Balance');

// Current balance is 135, last purchase was 350, threshold = 70
assert(checkLowBalance(TEST_PHONE) === null, 'Balance 135 > threshold 70: no warning');

// Consume to get below threshold
consumeCredits(TEST_PHONE, 70, 'test consumption');
assert(checkLowBalance(TEST_PHONE) === 'low_balance', 'Balance 65 < threshold 70: low_balance warning');

// Consume to zero
consumeCredits(TEST_PHONE, 65, 'drain balance');
assert(checkLowBalance(TEST_PHONE) === 'zero_balance', 'Balance 0: zero_balance warning');

// ── 6. Credit System — Format Functions ────────────────────────────
console.log('\n📋 6. Credit System — Formatting');

const balanceSummary = formatBalanceSummary(TEST_PHONE);
assert(typeof balanceSummary === 'string', 'Balance summary is a string');
assert(balanceSummary.length > 0, 'Balance summary is not empty');

const packages = formatCreditPackages();
assert(packages.includes('Starter'), 'Packages include Starter');
assert(packages.includes('Plus'), 'Packages include Plus');
assert(packages.includes('Pro'), 'Packages include Pro');

const txFormatted = formatTransactionHistory(TEST_PHONE);
assert(typeof txFormatted === 'string', 'Formatted history is a string');

// ── 7. Credit Packages ─────────────────────────────────────────────
console.log('\n📦 7. Credit Packages');

assert(CREDIT_PACKAGES.starter.credits === 100, 'Starter: 100 credits');
assert(CREDIT_PACKAGES.plus.credits === 350, 'Plus: 350 credits');
assert(CREDIT_PACKAGES.pro.credits === 650, 'Pro: 650 credits');
assert(SILENT_CONSUMPTION_LIMIT === 20, 'Silent consumption limit is 20');

// ── 8. User Profile — Storage ──────────────────────────────────────
console.log('\n👤 8. User Profile — Storage');

const emptyProfile = getUserProfile(TEST_PHONE);
assert(typeof emptyProfile === 'object', 'Empty profile returns object');
assert(Object.keys(emptyProfile).length === 0, 'Empty profile has no keys');

const testProfile = {
  name: 'Maria',
  location: 'Veracruz',
  family_members: ['Papa Jose, 72 anos'],
  medical_context: 'Papa tiene diabetes tipo 2',
  preferences: 'Prefiere comunicacion directa',
};
saveUserProfile(TEST_PHONE, testProfile);

const savedProfile = getUserProfile(TEST_PHONE);
assert(savedProfile.name === 'Maria', 'Profile name saved correctly');
assert(savedProfile.location === 'Veracruz', 'Profile location saved correctly');
assert(Array.isArray(savedProfile.family_members), 'Family members is an array');
assert(savedProfile.medical_context.includes('diabetes'), 'Medical context saved');

// Update profile (merge behavior)
const updatedProfile = { ...savedProfile, active_interests: 'health tracking' };
saveUserProfile(TEST_PHONE, updatedProfile);
const reloaded = getUserProfile(TEST_PHONE);
assert(reloaded.name === 'Maria', 'Name preserved after update');
assert(reloaded.active_interests === 'health tracking', 'New field added');

// ── 9. Projects — CRUD ─────────────────────────────────────────────
console.log('\n📁 9. Projects — CRUD');

const project = createProject(TEST_PHONE, 'health_tracker', 'Salud de Don Jose', {
  patient_name: 'Jose Martinez',
  age: 72,
  conditions: ['Diabetes tipo 2', 'Hipertension'],
});
assert(project.id > 0, 'Project created with valid ID');
assert(project.project_type === 'health_tracker', 'Project type is health_tracker');

const activeProjects = getActiveProjects(TEST_PHONE);
assert(activeProjects.length >= 1, 'Active projects found');
assert(activeProjects[0].project_name === 'Salud de Don Jose', 'Project name correct');
assert(activeProjects[0].context.patient_name === 'Jose Martinez', 'Project context parsed correctly');

// Update context
updateProjectContext(project.id, { patient_name: 'Jose Martinez', age: 72, conditions: ['Diabetes tipo 2', 'Hipertension'], latest_visit: '2026-03-24' });
const updatedProject = getProjectById(project.id);
assert(updatedProject.context.latest_visit === '2026-03-24', 'Project context updated');

// Add credits consumed
addProjectCredits(project.id, 50);
const projectWithCredits = getProjectById(project.id);
assert(projectWithCredits.credits_consumed === 50, 'Project credits tracked');

// Archive project
updateProjectStatus(project.id, 'archived');
const archivedProjects = getActiveProjects(TEST_PHONE);
const stillActive = archivedProjects.filter(p => p.id === project.id);
assert(stillActive.length === 0, 'Archived project not in active list');

// Create another active project for memory context tests
const project2 = createProject(TEST_PHONE, 'website', 'Landing Tacos El Guero', { type: 'restaurant' });

// ── 10. Memory Context — Build ─────────────────────────────────────
console.log('\n🧠 10. Memory Context — Build');

// Ensure user exists for foreign key constraint
getOrCreateUser(TEST_PHONE);

// Add some messages for context
saveMessage(TEST_PHONE, 'user', 'Hola, quiero llevar un registro de salud de mi papa');
saveMessage(TEST_PHONE, 'assistant', 'Claro, vamos a crear una pagina de salud. Como se llama?');
saveMessage(TEST_PHONE, 'user', 'Jose Martinez, tiene 72 anos');

const memCtx = buildMemoryContext(TEST_PHONE, 20);
assert(memCtx.profile.name === 'Maria', 'Memory context includes profile');
assert(memCtx.projects.length >= 1, 'Memory context includes active projects');
assert(memCtx.conversationHistory.length >= 3, 'Memory context includes conversation history');
assert(typeof memCtx.contextBlock === 'string', 'Context block is a string');
assert(memCtx.contextBlock.includes('Maria'), 'Context block mentions user name');
assert(memCtx.contextBlock.includes('Landing Tacos El Guero'), 'Context block mentions active project');

// ── 11. Profile Update Interval ────────────────────────────────────
console.log('\n🔄 11. Profile Update Interval');

// Create a fresh user for this test
const PROFILE_TEST_PHONE = 'test_profile_interval_' + Date.now();
getOrCreateUser(PROFILE_TEST_PHONE);

// shouldUpdateProfile checks total_messages from users table
// saveMessage calls updateMessageCount which increments users.total_messages
assert(shouldUpdateProfile(PROFILE_TEST_PHONE) === false, 'No update at 0 messages');

// Send 5 messages (saveMessage increments total_messages via updateMessageCount)
for (let i = 0; i < 5; i++) saveMessage(PROFILE_TEST_PHONE, 'user', `test msg ${i}`);
assert(getUserMessageCount(PROFILE_TEST_PHONE) === 5, 'Message count is 5');
assert(shouldUpdateProfile(PROFILE_TEST_PHONE) === true, 'Update triggered at 5 messages');

// Send 1 more → total 6
saveMessage(PROFILE_TEST_PHONE, 'user', 'test msg 5');
assert(shouldUpdateProfile(PROFILE_TEST_PHONE) === false, 'No update at 6 messages');

// Send 4 more → total 10
for (let i = 0; i < 4; i++) saveMessage(PROFILE_TEST_PHONE, 'user', `test msg ${6 + i}`);
assert(shouldUpdateProfile(PROFILE_TEST_PHONE) === true, 'Update triggered at 10 messages');

// ── 12. AI Action Type Parsing ─────────────────────────────────────
console.log('\n🤖 12. AI Action Type Parsing');

const freeResponse = 'Hola, como te va? {"action_type": "free"}';
const parsed1 = parseActionType(freeResponse);
assert(parsed1.actionType === 'free', 'Free action parsed');
assert(parsed1.credits === 0, 'Free action has 0 credits');
assert(parsed1.cleanResponse === 'Hola, como te va?', 'Clean response correct for free');

const smallAction = 'Listo, agregue el resultado. {"action_type": "small_action", "credits": 5, "description": "resultado de laboratorio"}';
const parsed2 = parseActionType(smallAction);
assert(parsed2.actionType === 'small_action', 'Small action parsed');
assert(parsed2.credits === 5, 'Small action credits is 5');
assert(parsed2.actionDescription === 'resultado de laboratorio', 'Action description parsed');
assert(!parsed2.cleanResponse.includes('action_type'), 'JSON stripped from response');

const quotedProject = 'Esto costaria unos 80 creditos. Le damos? {"action_type": "quoted_project", "credits": 80, "description": "crear pagina web"}';
const parsed3 = parseActionType(quotedProject);
assert(parsed3.actionType === 'quoted_project', 'Quoted project parsed');
assert(parsed3.credits === 80, 'Quoted project credits is 80');

const noTag = 'Just a normal response without any tags';
const parsed4 = parseActionType(noTag);
assert(parsed4.actionType === 'free', 'No tag defaults to free');
assert(parsed4.cleanResponse === noTag, 'Clean response unchanged when no tag');

// ── 13. Credit Intent Detection ────────────────────────────────────
console.log('\n💬 13. Credit Intent Detection');

assert(detectCreditIntent('cuantos creditos tengo?')?.type === 'balance_check', 'Detects balance check (no accent)');
assert(detectCreditIntent('cuántos créditos tengo')?.type === 'balance_check', 'Detects balance check (with accent)');
assert(detectCreditIntent('mi saldo')?.type === 'balance_check', 'Detects "mi saldo"');
assert(detectCreditIntent('quiero comprar creditos')?.type === 'buy_credits', 'Detects buy credits');
assert(detectCreditIntent('quiero recargar')?.type === 'buy_credits', 'Detects recargar');
assert(detectCreditIntent('dame mi historial de creditos')?.type === 'transaction_history', 'Detects transaction history');
assert(detectCreditIntent('hola como estas') === null, 'No credit intent in casual message');
assert(detectCreditIntent('quiero una pagina web') === null, 'No credit intent in service request');

// ── 14. Credit Intent Handling ─────────────────────────────────────
console.log('\n🎯 14. Credit Intent Handling');

// Reload credits for this test
addCredits(TEST_PHONE, 100, 'Test reload');
const balanceResponse = handleCreditIntent(TEST_PHONE, 'cuantos creditos tengo?');
assert(balanceResponse !== null, 'Balance intent returns response');
assert(balanceResponse.includes('100'), 'Balance response includes credit count');

const buyResponse = handleCreditIntent(TEST_PHONE, 'quiero comprar creditos');
assert(buyResponse !== null, 'Buy intent returns response');
assert(buyResponse.includes('Starter'), 'Buy response includes packages');

const historyResponse = handleCreditIntent(TEST_PHONE, 'historial de creditos');
assert(historyResponse !== null, 'History intent returns response');

const noIntent = handleCreditIntent(TEST_PHONE, 'hola');
assert(noIntent === null, 'Casual message returns null');

// ── 15. Project Credits Tracking ───────────────────────────────────
console.log('\n📊 15. Project Credits Tracking');

const creditProject = createProject(TEST_PHONE, 'health_tracker', 'Test Credit Tracking', {});
addCredits(TEST_PHONE, 200, 'Test load');

const consumeWithProject = consumeCredits(TEST_PHONE, 5, 'Test update', creditProject.id);
assert(consumeWithProject.success === true, 'Consumption with project ID succeeds');

const trackedProject = getProjectById(creditProject.id);
assert(trackedProject.credits_consumed === 5, 'Project credits_consumed updated via consumeCredits');

// ── Summary ────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
