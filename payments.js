import crypto from 'crypto';
import config from './config.js';
import { markDeliverablePaid, getActiveDeliverable } from './db.js';
import { sendMessage } from './whatsapp.js';

/**
 * Create a MercadoPago payment preference for a deliverable.
 *
 * @param {string} phone - User phone number
 * @param {object} [options] - Deliverable payment details
 * @param {string} [options.title] - Item title
 * @param {number} [options.price] - Price in MXN
 * @param {string} [options.reference] - External reference (e.g. deliverable:123:phone)
 * @param {number} [options.deliverableId] - Deliverable DB ID
 * @returns {Promise<{ url: string, preferenceId?: string, configured: boolean }>}
 */
export async function createPaymentLink(phone, options = {}) {
  const amount = options.price || 100;
  const title = options.title || 'Servicio Tavole';
  const deliverableId = options.deliverableId || 0;
  const reference = options.reference || `deliverable:${deliverableId}:${phone}`;

  if (!config.mercadoPagoAccessToken) {
    console.warn('[PAYMENTS] MercadoPago not configured — returning placeholder link');
    return {
      url: `https://tavole.ai/pagar?ref=${encodeURIComponent(reference)}&amount=${amount}`,
      configured: false,
    };
  }

  try {
    const res = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.mercadoPagoAccessToken}`,
      },
      body: JSON.stringify({
        items: [
          {
            title,
            quantity: 1,
            unit_price: amount,
            currency_id: 'MXN',
          },
        ],
        external_reference: reference,
        back_urls: {
          success: 'https://tavole.ai/pago-exitoso',
          failure: 'https://tavole.ai/pago-fallido',
          pending: 'https://tavole.ai/pago-pendiente',
        },
        auto_return: 'approved',
        notification_url: config.webhookBaseUrl
          ? `${config.webhookBaseUrl}/payment/webhook`
          : 'https://tavole.ai/payment/webhook',
        payment_methods: {
          // Enable all methods including OXXO and SPEI
          excluded_payment_types: [],
          installments: 1, // No installments for services
        },
        expires: true,
        expiration_date_to: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[PAYMENTS] MercadoPago error ${res.status}: ${err}`);
      return {
        url: `https://tavole.ai/pagar?ref=${encodeURIComponent(reference)}&amount=${amount}`,
        configured: false,
      };
    }

    const data = await res.json();
    console.log(`[PAYMENTS] ✅ Preference created: ${data.id} for ${reference} ($${amount} MXN)`);
    return {
      url: data.init_point,
      preferenceId: data.id,
      configured: true,
    };
  } catch (err) {
    console.error('[PAYMENTS] Error creating preference:', err);
    return {
      url: `https://tavole.ai/pagar?ref=${encodeURIComponent(reference)}&amount=${amount}`,
      configured: false,
    };
  }
}

/**
 * Validate MercadoPago webhook HMAC signature.
 * See: https://www.mercadopago.com.mx/developers/en/docs/your-integrations/notifications/webhooks
 *
 * @param {object} req - Express request
 * @returns {boolean}
 */
function validateWebhookSignature(req) {
  const secret = config.mercadoPagoWebhookSecret;
  if (!secret) {
    console.warn('[PAYMENTS] No webhook secret configured — skipping HMAC validation');
    return true; // Allow in dev/sandbox mode
  }

  const xSignature = req.headers['x-signature'];
  const xRequestId = req.headers['x-request-id'];
  if (!xSignature || !xRequestId) {
    console.warn('[PAYMENTS] Missing x-signature or x-request-id headers');
    return false;
  }

  // Parse x-signature: "ts=TIMESTAMP,v1=HASH"
  const parts = {};
  for (const part of xSignature.split(',')) {
    const [key, value] = part.split('=', 2);
    parts[key.trim()] = value?.trim();
  }

  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) {
    console.warn('[PAYMENTS] Malformed x-signature header');
    return false;
  }

  // Build the signed string: id=DATA_ID&request-id=X_REQUEST_ID&ts=TIMESTAMP
  const dataId = req.query?.['data.id'] || req.body?.data?.id || '';
  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;

  const hmac = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  if (hmac !== v1) {
    console.error('[PAYMENTS] ⚠️ HMAC validation failed — possible spoofed webhook');
    return false;
  }

  return true;
}

/**
 * Parse "deliverable:ID:PHONE" reference format.
 * @param {string} reference
 * @returns {{ deliverableId: number, phone: string } | null}
 */
function parseReference(reference) {
  if (!reference) return null;
  const parts = reference.split(':');
  if (parts[0] !== 'deliverable' || parts.length < 3) return null;
  return {
    deliverableId: parseInt(parts[1], 10),
    phone: parts.slice(2).join(':'),
  };
}

// Track processed payment IDs to ensure idempotency within process lifetime
const processedPayments = new Set();

/**
 * Handle MercadoPago IPN webhook notification.
 * Verifies signature, fetches payment, and updates deliverable status.
 */
export async function handlePaymentWebhook(req, res) {
  // Acknowledge immediately (MercadoPago retries if no 200 within 10s)
  res.status(200).send('OK');

  try {
    // Validate HMAC signature
    if (!validateWebhookSignature(req)) {
      console.error('[PAYMENTS] Webhook rejected — invalid signature');
      return;
    }

    const { type, data } = req.body;

    // Only process payment notifications
    if (type !== 'payment') return;

    const paymentId = data?.id;
    if (!paymentId) return;

    // Idempotency check
    if (processedPayments.has(String(paymentId))) {
      console.log(`[PAYMENTS] Payment ${paymentId} already processed — skipping`);
      return;
    }

    if (!config.mercadoPagoAccessToken) {
      console.warn('[PAYMENTS] Webhook received but MercadoPago not configured');
      return;
    }

    // Fetch payment details from MercadoPago
    const paymentRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: {
        Authorization: `Bearer ${config.mercadoPagoAccessToken}`,
      },
    });

    if (!paymentRes.ok) {
      console.error(`[PAYMENTS] Failed to fetch payment ${paymentId}: ${paymentRes.status}`);
      return;
    }

    const payment = await paymentRes.json();
    const ref = parseReference(payment.external_reference);

    if (!ref) {
      console.warn(`[PAYMENTS] Payment ${paymentId} has invalid reference: ${payment.external_reference}`);
      return;
    }

    // Verify amount matches (anti-tampering)
    const deliverable = getActiveDeliverable(ref.phone);
    if (deliverable && Math.abs(payment.transaction_amount - deliverable.price_mxn) > 1) {
      console.error(
        `[PAYMENTS] ⚠️ Amount mismatch! Expected $${deliverable.price_mxn}, got $${payment.transaction_amount} (payment ${paymentId})`
      );
      // Still process but log the discrepancy
    }

    const paymentMethod = payment.payment_method_id || payment.payment_type_id || 'unknown';

    switch (payment.status) {
      case 'approved': {
        processedPayments.add(String(paymentId));
        markDeliverablePaid(ref.deliverableId, String(paymentId));
        console.log(
          `[PAYMENTS] ✅ Deliverable ${ref.deliverableId} paid by ${ref.phone} via ${paymentMethod} (payment #${paymentId}, $${payment.transaction_amount} MXN)`
        );
        await sendMessage(
          ref.phone,
          `✅ *¡Pago confirmado!* ($${payment.transaction_amount} MXN)\n\n` +
            `Tu proyecto está en marcha. Te iré actualizando conforme avance. 🚀`
        );
        break;
      }

      case 'pending':
      case 'in_process': {
        // OXXO, SPEI, or processing — notify user
        const isOxxo = paymentMethod === 'oxxo' || paymentMethod === 'efecty';
        console.log(
          `[PAYMENTS] ⏳ Payment ${paymentId} pending (${paymentMethod}) for deliverable ${ref.deliverableId}`
        );
        if (isOxxo) {
          await sendMessage(
            ref.phone,
            `🏪 *Pago en OXXO registrado*\n\n` +
              `Tu pago se confirmará en 1-3 horas después de que pagues en la tienda. ` +
              `Te avisaré en cuanto se acredite. 👍`
          );
        } else {
          await sendMessage(
            ref.phone,
            `⏳ *Pago en proceso*\n\n` +
              `Tu pago está siendo procesado. Te confirmaré en cuanto se acredite.`
          );
        }
        break;
      }

      case 'rejected':
      case 'cancelled': {
        console.log(`[PAYMENTS] ❌ Payment ${paymentId} ${payment.status} (${paymentMethod})`);
        await sendMessage(
          ref.phone,
          `❌ *El pago no se pudo procesar*\n\n` +
            `¿Quieres intentar de nuevo? Te puedo generar otro enlace de pago.`
        );
        break;
      }

      default:
        console.log(`[PAYMENTS] Payment ${paymentId} status: ${payment.status} — no action taken`);
    }
  } catch (err) {
    console.error('[PAYMENTS] Webhook error:', err);
  }
}

/**
 * Handle GET /payment/create?phone=XXXX — generates a payment link.
 * (Admin/testing endpoint)
 */
export async function handleCreatePayment(req, res) {
  const phone = req.query.phone;
  if (!phone) {
    return res.status(400).json({ error: 'Missing phone parameter' });
  }

  const deliverable = getActiveDeliverable(phone);
  const result = await createPaymentLink(phone, {
    title: deliverable?.description || 'Servicio Tavole',
    price: deliverable?.price_mxn || 100,
    deliverableId: deliverable?.id || 0,
  });
  res.json(result);
}
