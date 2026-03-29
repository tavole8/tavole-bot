import express from 'express';
import config from './config.js';
import { parseMessage, sendMessage, verifyWebhook, markAsRead } from './whatsapp-meta.js';
import { chat, handleCreditIntent } from './ai.js';
import {
  incrementMessageCount,
  logConversationCost,
  getOrCreateUser,
  getPendingDeliverable,
  updateDeliverableStatus,
} from './db.js';
import { parseIntent, processIntent, getConversationState, transitionState } from './intent.js';
import { generateQuote } from './quotes.js';
import { handlePaymentWebhook, handleCreatePayment, createPaymentLink } from './payments.js';
import { consumeCredits, checkLowBalance } from './credits.js';
import { shouldUpdateProfile, extractUserProfile } from './memory.js';
import { healthHandler, recordMessage } from './health.js';
import { sanitizeInput, rateLimiter, filterOutput, validatePhone } from './security.js';
import log from './logger.js';

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Health check endpoints
app.get('/', (_req, res) => {
  res.send('Tavole bot is running');
});
app.get('/health', healthHandler);

// ── Payment endpoints ───────────────────────────────────────────────
app.post('/payment/webhook', handlePaymentWebhook);
app.get('/payment/create', handleCreatePayment);

// Meta WhatsApp webhook verification (GET)
app.get('/webhook', verifyWebhook);

// Meta WhatsApp incoming messages (POST)
app.post('/webhook', rateLimiter, async (req, res) => {
  // Respond 200 OK immediately to avoid Meta retries
  res.sendStatus(200);

  try {
    const msg = parseMessage(req.body);
    if (!msg) return;

    // Validate phone number (Mexican numbers only)
    if (!validatePhone(msg.from)) {
      log.info('msg_skip_invalid_phone', { from: msg.from, reason: 'failed phone validation' });
      return;
    }

    // Check rate limiting (flag set by rateLimiter middleware)
    if (req.rateLimited) {
      await sendMessage(msg.from, 'Dale un respiro, estamos procesando tus mensajes anteriores.');
      log.info('msg_rate_limited', { from: msg.from });
      return;
    }

    // Skip WhatsApp system/setup messages
    if (msg.text && /continue setting up|seguir configurando|verify your number/i.test(msg.text)) {
      log.info('msg_skip_system', { from: msg.from, text: msg.text.slice(0, 60) });
      return;
    }

    // Mark as read (blue ticks) — fire and forget
    markAsRead(msg.messageId).catch(() => {});

    // Only handle text messages for now
    if (msg.type !== 'text' || !msg.text) {
      await sendMessage(msg.from, 'Por ahora solo puedo leer mensajes de texto. Enviame un mensaje escrito.');
      return;
    }

    recordMessage();
    log.info('msg_in', { from: msg.from, text: msg.text.slice(0, 100) });

    // Get or create user — send welcome to new users
    const { isNew } = getOrCreateUser(msg.from);
    if (isNew) {
      await sendWelcome(msg.from);
    }

    // ── Credit intent detection (handle before AI call) ──────────
    const creditResponse = handleCreditIntent(msg.from, msg.text);
    if (creditResponse) {
      await sendMessage(msg.from, creditResponse);
      console.log(`[CREDIT INTENT] ${msg.from}: ${msg.text.slice(0, 50)}`);
      return;
    }

    // ── Deliverable quote confirmation flow ────────────────────────
    const pendingDeliverable = getPendingDeliverable(msg.from);
    if (pendingDeliverable) {
      const handled = await handleDeliverableResponse(msg.from, msg.text, pendingDeliverable);
      if (handled) return;
    }

    // ── Sanitize input before AI processing ───────────────────────
    const sanitized = sanitizeInput(msg.text);
    const textForAI = sanitized.cleanText || msg.text;

    // ── Get conversation state and send to AI ──────────────────────
    const conversationState = getConversationState(msg.from);

    const aiOptions = { conversationState };
    if (sanitized.isInjectionAttempt) {
      aiOptions.injectionWarning = true;
      log.info('security_injection_attempt', { from: msg.from, patterns: sanitized.patterns });
    }

    const startTime = Date.now();
    const result = await chat(msg.from, msg.name, textForAI, aiOptions);
    const durationMs = Date.now() - startTime;

    // Increment message count (still useful for analytics)
    incrementMessageCount(msg.from);

    // Log cost
    logConversationCost(msg.from, durationMs, result.estimatedCost, result.model);

    // ── Handle credit consumption for small actions ────────────────
    if (result.actionType === 'small_action' && result.actionCredits > 0) {
      const creditResult = consumeCredits(
        msg.from,
        result.actionCredits,
        result.actionDescription || 'Accion menor',
        null // projectId — could be enhanced to detect from context
      );

      if (!creditResult.success) {
        // Override reply: not enough credits
        result.reply = 'No tienes creditos suficientes para esta accion. Quieres recargar?';
      } else if (creditResult.warning === 'low_balance') {
        // Append low balance warning
        result.reply += '\n\n(Te quedan pocos creditos. Quieres recargar?)';
      }
    }

    // ── Intent detection & quote generation ────────────────────────
    const { cleanResponse, intent, quoteRequest } = parseIntent(result.reply);

    if (intent) {
      processIntent(msg.from, intent);
    }

    // Filter output before sending
    const preFilterResponse = cleanResponse || result.reply;
    const filtered = filterOutput(preFilterResponse);
    if (filtered.wasFiltered) {
      log.info('security_output_filtered', { to: msg.from, reason: filtered.reason });
    }
    const finalResponse = filtered.cleanText;
    log.info('msg_out', { to: msg.from, durationMs, model: result.model, action: result.actionType, text: finalResponse.slice(0, 100) });
    await sendMessage(msg.from, finalResponse);

    // If AI flagged quote-ready, generate and send the formal quote
    if (quoteRequest) {
      try {
        const { quoteMessage } = await generateQuote(
          msg.from,
          quoteRequest.category,
          quoteRequest.description,
          quoteRequest.tier
        );
        transitionState(msg.from, 'quoting');
        await sendMessage(msg.from, quoteMessage);
        console.log(`[QUOTE SENT] ${msg.from} — ${quoteRequest.category}: ${quoteRequest.description}`);
      } catch (quoteErr) {
        console.error('Error generating quote:', quoteErr);
        await sendMessage(msg.from, 'Tuve un problema armando la cotizacion. Dame un momento y lo intento de nuevo.');
        transitionState(msg.from, 'chatting');
      }
    }

    // ── Profile extraction (every 5th message, async) ──────────────
    if (shouldUpdateProfile(msg.from)) {
      // Fire and forget — don't block the response
      extractUserProfile(msg.from).catch(err => {
        console.error('[PROFILE] Extraction error:', err.message);
      });
    }
  } catch (err) {
    log.error('msg_handler_error', { error: err.message, stack: err.stack?.slice(0, 300) });
  }
});

/**
 * Handle a user's response to a pending deliverable quote.
 * Returns true if the response was handled (confirmed/cancelled), false otherwise.
 */
async function handleDeliverableResponse(userPhone, text, deliverable) {
  const lower = text.toLowerCase().trim();

  const confirmPatterns = ['si', 'sí', 'yes', 'dale', 'va', 'confirmo', 'adelante', 'okay', 'ok', 'sale'];
  const cancelPatterns = ['no', 'cancel', 'cancelar', 'nope', 'nel', 'mejor no', 'no gracias'];

  if (confirmPatterns.includes(lower)) {
    // Generate a fresh payment link instead of marking paid on text confirmation
    const payment = await createPaymentLink(userPhone, {
      title: `Tavole — ${deliverable.description}`,
      price: deliverable.price_mxn,
      reference: `deliverable:${deliverable.id}:${userPhone}`,
      deliverableId: deliverable.id,
    });

    if (payment.configured) {
      // MercadoPago is live — require real payment
      transitionState(userPhone, 'awaiting_payment');
      const confirmMsg = `*Perfecto!* Aqui esta tu enlace de pago:\n\n` +
        `${payment.url}\n\n` +
        `Proyecto: ${deliverable.description}\n` +
        `Precio: $${deliverable.price_mxn?.toLocaleString('es-MX')} MXN\n\n` +
        `Puedes pagar con tarjeta, OXXO o SPEI. ` +
        `Te confirmo en cuanto se acredite tu pago.`;
      await sendMessage(userPhone, confirmMsg);
      console.log(`[PAYMENT LINK SENT] ${userPhone} id=${deliverable.id} url=${payment.url}`);
    } else {
      // MercadoPago not configured (dev/sandbox) — mark paid directly for testing
      updateDeliverableStatus(deliverable.id, 'paid');
      transitionState(userPhone, 'in_progress');
      const confirmMsg = `*Proyecto confirmado.* (modo sandbox, sin cobro)\n\n` +
        `Proyecto: ${deliverable.description}\n` +
        `Precio: $${deliverable.price_mxn?.toLocaleString('es-MX')} MXN\n\n` +
        `Empiezo a trabajar. Te voy actualizando por aqui.\n\n` +
        `Si necesitas cancelar, escribe "cancelar proyecto".`;
      await sendMessage(userPhone, confirmMsg);
      console.log(`[DELIVERABLE CONFIRMED - SANDBOX] ${userPhone} id=${deliverable.id}`);
    }
    return true;
  }

  if (cancelPatterns.includes(lower)) {
    updateDeliverableStatus(deliverable.id, 'cancelled');
    transitionState(userPhone, 'chatting');
    await sendMessage(userPhone, 'Sale, cotizacion cancelada. Si necesitas algo mas, aqui estoy.');
    console.log(`[DELIVERABLE CANCELLED] ${userPhone} id=${deliverable.id}`);
    return true;
  }

  return false;
}

/**
 * Send welcome message + privacy notice to new users.
 */
async function sendWelcome(userPhone) {
  const welcomeMsg = `Hola, soy Tavole. Preguntame lo que sea.\n\n` +
    `_Privacidad: ${config.privacyNoticeUrl} | Terminos: ${config.termsOfServiceUrl}_`;

  await sendMessage(userPhone, welcomeMsg);
  console.log(`[WELCOME] New user: ${userPhone}`);
}

// Graceful shutdown
function shutdown(signal) {
  log.info('shutdown', { signal });
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Catch unhandled errors to avoid silent crashes
process.on('uncaughtException', (err) => {
  log.error('uncaught_exception', { error: err.message, stack: err.stack?.slice(0, 500) });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandled_rejection', { error: String(reason) });
});

app.listen(config.port, () => {
  log.info('server_start', { port: config.port, env: process.env.NODE_ENV || 'development' });
});
