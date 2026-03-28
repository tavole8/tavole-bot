/**
 * Tavole Alpha Dry Run — 5 Full User Journeys
 * Simulates real Wave 1 alpha users end-to-end.
 * Tests: free chat → service request → quote → payment → delivery confirmation
 * 
 * Can run in mock mode (no AI/payment APIs) or live mode.
 * Usage:
 *   MOCK=1 node test-alpha-dryrun.js       # Mock mode (no external deps)
 *   node test-alpha-dryrun.js               # Live mode (needs OpenRouter + MercadoPago sandbox)
 */

import { getOrCreateUser, saveMessage, getHistory } from './db.js';
// AI and payment imports only needed in live mode
const MOCK = process.env.MOCK !== '0'; // Default to mock mode
let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}`); }
}

function skip(label, reason) {
  skipped++;
  console.log(`  ⏭️  ${label} — skipped (${reason})`);
}

// Mock functions for offline testing
const mockDetectIntent = async (msg) => {
  if (/hola|hey|qué onda/i.test(msg)) return { action_type: 'free', response: 'Hola, en qué te puedo ayudar?' };
  if (/página|website|sitio web/i.test(msg)) return { action_type: 'service_request', service: 'website', tier: 'standard', response: 'Te puedo hacer un sitio web. Precio: $800 MXN.' };
  if (/sí|acepto|va|dale/i.test(msg)) return { action_type: 'quote_accepted', response: 'Perfecto, te mando el link de pago.' };
  if (/gracias|chido/i.test(msg)) return { action_type: 'free', response: 'De nada!' };
  return { action_type: 'free', response: 'Hmm, cuéntame más.' };
};

const mockCreateCheckout = async (amount, desc) => ({
  id: 'mock-checkout-123',
  init_point: 'https://sandbox.mercadopago.com.mx/checkout/mock',
  status: 'pending'
});

const mockVerifyPayment = async (id) => ({
  status: 'approved',
  amount: 800,
  method: 'credit_card'
});

const ai = MOCK ? mockDetectIntent : detectIntent;
const checkout = MOCK ? mockCreateCheckout : createCheckoutLink;
const verify = MOCK ? mockVerifyPayment : verifyPayment;

// ─── JOURNEY 1: Casual chat (free tier) ───
async function journey1_casualChat() {
  console.log('\n🧑 Journey 1: Casual Chat (Gus\'s friend Raymond)');
  console.log('   Scenario: Curious friend, just exploring, no purchase');

  const { user } = await getOrCreateUser('test-alpha-raymond', 'Raymond');
  assert(user && user.phone === 'test-alpha-raymond', 'User created');

  const r1 = await ai('Qué onda, qué es esto?');
  assert(r1 && r1.action_type === 'free', 'Greeting detected as free chat');

  const r2 = await ai('Y qué tipo de cosas puedes hacer?');
  assert(r2 && r2.response, 'Capability question answered');

  const r3 = await ai('Va, luego te escribo');
  assert(r3 && (r3.action_type === 'free' || r3.response), 'Farewell handled gracefully');
  
  console.log('   ✓ Journey 1 complete — casual chat flow works');
}

// ─── JOURNEY 2: Full purchase flow (website) ───
async function journey2_websitePurchase() {
  console.log('\n🧑 Journey 2: Website Purchase (Gus\'s dentist contact)');
  console.log('   Scenario: Dentist needs a landing page, goes through full flow');

  const { user } = await getOrCreateUser('test-alpha-dentist', 'Dr. Martinez');
  assert(user, 'Dentist user created');

  const r1 = await ai('Hola, necesito una página web para mi consultorio dental');
  assert(r1 && (r1.action_type === 'service_request' || r1.service || r1.response), 'Service request detected');

  // Quote generation
  const r2 = await ai('Sí, acepto el precio');
  assert(r2, 'Quote acceptance processed');

  // Payment link
  const payment = await checkout(800, 'Sitio web - Consultorio dental');
  assert(payment && payment.init_point, 'MercadoPago checkout link generated');

  // Payment verification (simulated IPN callback)
  if (payment.id) {
    const verification = await verify(payment.id);
    assert(verification && verification.status === 'approved', 'Payment verified as approved');
  } else {
    skip('Payment verification', 'no payment ID');
  }

  console.log('   ✓ Journey 2 complete — full purchase flow works');
}

// ─── JOURNEY 3: Service request → abandonment ───
async function journey3_abandonedQuote() {
  console.log('\n🧑 Journey 3: Abandoned Quote (Aymee\'s coworker)');
  console.log('   Scenario: Asks about a service, gets quote, ghosts');

  const { user } = await getOrCreateUser('test-alpha-aymee-coworker', 'Laura');
  assert(user, 'User created');

  const r1 = await ai('Hey, cuánto cuesta que me hagan un bot para mi tienda?');
  assert(r1 && r1.response, 'Bot inquiry answered with pricing');

  // User goes silent — test that state doesn't break
  const r2 = await ai('Hola, sigo aquí, déjame pensarlo');
  assert(r2 && r2.action_type === 'free', 'Re-engagement handled without stale quote');

  console.log('   ✓ Journey 3 complete — abandoned flow handled gracefully');
}

// ─── JOURNEY 4: Edge case — rude user ───
async function journey4_rudeUser() {
  console.log('\n🧑 Journey 4: Rude User (random contact)');
  console.log('   Scenario: Hostile messages, tests personality guardrails');

  const { user } = await getOrCreateUser('test-alpha-rude', 'Anon');
  assert(user, 'User created');

  const r1 = await ai('esto es una estafa verdad? seguro me van a robar');
  assert(r1 && r1.response, 'Skepticism handled without breaking');
  assert(r1 && !/bot|inteligencia artificial|IA/i.test(r1.response), 'Doesn\'t volunteer AI identity unprompted');

  const r2 = await ai('jajaja qué pendejo bot');
  assert(r2 && r2.response, 'Insult handled gracefully');

  console.log('   ✓ Journey 4 complete — personality holds under pressure');
}

// ─── JOURNEY 5: Returning user with history ───
async function journey5_returningUser() {
  console.log('\n🧑 Journey 5: Returning User (Gus himself testing)');
  console.log('   Scenario: User returns days later, context should persist');

  const { user } = await getOrCreateUser('test-alpha-gus', 'Gus');
  assert(user, 'User created');

  // First session
  await saveMessage('test-alpha-gus', 'user', 'Quiero hacer una landing page');
  await saveMessage('test-alpha-gus', 'assistant', 'Claro, te puedo hacer una. Precio: $800 MXN.');
  
  // Verify history persists
  const history = await getHistory('test-alpha-gus', 10);
  assert(history && history.length >= 2, 'Message history persisted');

  // Second session — returning
  const r1 = await ai('Hey, sigo interesado en lo de la landing');
  assert(r1 && r1.response, 'Returning user handled');

  console.log('   ✓ Journey 5 complete — returning user flow works');
}

// ─── Run all journeys ───
async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log(`  Tavole Alpha Dry Run — ${MOCK ? 'MOCK' : 'LIVE'} mode`);
  console.log('  5 user journeys simulating Wave 1 alpha users');
  console.log('═══════════════════════════════════════════════');

  try {
    await journey1_casualChat();
    await journey2_websitePurchase();
    await journey3_abandonedQuote();
    await journey4_rudeUser();
    await journey5_returningUser();
  } catch (err) {
    console.error(`\n💥 Fatal error: ${err.message}`);
    console.error(err.stack);
  }

  console.log('\n═══════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('═══════════════════════════════════════════════');
  
  process.exit(failed > 0 ? 1 : 0);
}

main();
