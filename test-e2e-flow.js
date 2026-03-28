/**
 * Tavole v2 — End-to-end flow test (offline, no Twilio/MercadoPago needed).
 *
 * Tests: intent parsing, quote generation, deliverable lifecycle, state transitions.
 * Run: node test-e2e-flow.js
 */

import { parseIntent, getConversationState, transitionState, processIntent } from './intent.js';
import { generateQuote, suggestTier, TIER_GUIDELINES } from './quotes.js';
import {
  getOrCreateUser,
  getPendingDeliverable,
  updateDeliverableStatus,
  getHistory,
  saveMessage,
  incrementMessageCount,
} from './db.js';

const TEST_PHONE = 'whatsapp:+521234567890';
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

// ── 1. Intent Parsing ──────────────────────────────────────────────
console.log('\n🔍 1. Intent Parsing');

const plainResponse = 'Claro, te puedo ayudar con eso. ¿Qué tipo de negocio tienes?';
const r1 = parseIntent(plainResponse);
assert(r1.intent === null, 'No intent in plain response');
assert(r1.quoteRequest === null, 'No quote request in plain response');
assert(r1.cleanResponse === plainResponse, 'Clean response unchanged');

const serviceResponse = 'Suena como que necesitas una página web para tu restaurante. ¿Te gustaría que te arme una propuesta? {"service_detected": true, "category": "website"}';
const r2 = parseIntent(serviceResponse);
assert(r2.intent !== null, 'Service intent detected');
assert(r2.intent?.category === 'website', 'Category is website');
assert(!r2.cleanResponse.includes('service_detected'), 'JSON tag stripped from response');

const quoteResponse = 'Perfecto, te preparo la cotización ahora mismo. {"quote_ready": true, "category": "website", "description": "Landing page para restaurante", "tier": "standard"}';
const r3 = parseIntent(quoteResponse);
assert(r3.quoteRequest !== null, 'Quote request detected');
assert(r3.quoteRequest?.category === 'website', 'Quote category correct');
assert(r3.quoteRequest?.tier === 'standard', 'Quote tier correct');
assert(!r3.cleanResponse.includes('quote_ready'), 'Quote JSON tag stripped');

// ── 2. Tier Suggestion ─────────────────────────────────────────────
console.log('\n💰 2. Tier Suggestion');

const websiteTier = suggestTier('website');
assert(websiteTier.tier === 'standard', 'Website → standard tier');
assert(websiteTier.price_mxn === 800, 'Standard price is 800 MXN');

const automationTier = suggestTier('automation');
assert(automationTier.tier === 'complex', 'Automation → complex tier');
assert(automationTier.price_mxn === 2000, 'Complex price is 2000 MXN');

const unknownTier = suggestTier('banana');
assert(unknownTier.tier === 'standard', 'Unknown category → standard fallback');

// ── 3. User Lifecycle ──────────────────────────────────────────────
console.log('\n👤 3. User Lifecycle');

const { isNew: firstTime } = getOrCreateUser(TEST_PHONE);
assert(firstTime === true, 'First getOrCreate → isNew=true');

const { isNew: secondTime } = getOrCreateUser(TEST_PHONE);
assert(secondTime === false, 'Second getOrCreate → isNew=false');

// ── 4. Conversation State ──────────────────────────────────────────
console.log('\n🔄 4. Conversation State');

const initialState = getConversationState(TEST_PHONE);
assert(initialState === 'chatting', 'Initial state is chatting');

transitionState(TEST_PHONE, 'exploring');
assert(getConversationState(TEST_PHONE) === 'exploring', 'State transitions to exploring');

transitionState(TEST_PHONE, 'quoting');
assert(getConversationState(TEST_PHONE) === 'quoting', 'State transitions to quoting');

transitionState(TEST_PHONE, 'chatting');
assert(getConversationState(TEST_PHONE) === 'chatting', 'State resets to chatting');

// ── 5. Quote Generation & Deliverable ──────────────────────────────
console.log('\n📋 5. Quote Generation & Deliverable');

const quote = await generateQuote(TEST_PHONE, 'website', 'Landing page para restaurante', 'standard');
assert(quote.deliverable !== undefined, 'Deliverable created');
assert(quote.deliverable.price_mxn === 800, 'Deliverable price matches tier');
assert(quote.quoteMessage.includes('800'), 'Quote message includes price');
assert(quote.quoteMessage.includes('Landing page'), 'Quote message includes description');
assert(quote.paymentUrl !== undefined, 'Payment URL generated');

// ── 6. Deliverable Status Flow ─────────────────────────────────────
console.log('\n📦 6. Deliverable Status Flow');

const pending = getPendingDeliverable(TEST_PHONE);
assert(pending !== undefined && pending !== null, 'Pending deliverable found');
assert(pending?.status === 'quoted', 'Deliverable status is quoted');

updateDeliverableStatus(pending.id, 'paid');
const afterPay = getPendingDeliverable(TEST_PHONE);
// After paying, there should be no more "pending" (quoted) deliverable
assert(afterPay === undefined || afterPay === null, 'No pending deliverable after payment');

// ── 7. Message History ─────────────────────────────────────────────
console.log('\n💬 7. Message History');

saveMessage(TEST_PHONE, 'user', 'Hola, necesito una página web');
saveMessage(TEST_PHONE, 'assistant', 'Claro, cuéntame más sobre tu negocio');
const history = getHistory(TEST_PHONE, 5);
assert(history.length >= 2, `History has ${history.length} messages (expected ≥2)`);

// ── 8. Message Count Analytics ─────────────────────────────────────
console.log('\n📊 8. Analytics');

incrementMessageCount(TEST_PHONE);
incrementMessageCount(TEST_PHONE);
// Just verifying it doesn't throw — no credit gating
assert(true, 'incrementMessageCount works without credit checks');

// ── Summary ────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
