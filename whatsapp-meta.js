/**
 * WhatsApp Cloud API adapter — drop-in replacement for whatsapp.js (Twilio).
 *
 * Swap in once Meta Developer Account is verified and WABA is set up.
 * Requires these env vars / config keys:
 *   - META_WHATSAPP_TOKEN   (System User permanent access token)
 *   - META_PHONE_NUMBER_ID  (from WABA → phone number settings)
 *   - META_VERIFY_TOKEN     (webhook verify token — you choose it)
 *
 * Usage:
 *   import { sendMessage, parseMessage, verifyWebhook } from './whatsapp-meta.js';
 */

import config from './config.js';

const API_VERSION = 'v22.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

// ──────────────────────────────────────────────────────────────
// Send
// ──────────────────────────────────────────────────────────────

/**
 * Send a text message via Meta WhatsApp Cloud API.
 * @param {string} to - Phone number (e.g. '5212345678901')
 * @param {string} text - Message body
 */
export async function sendMessage(to, text) {
  const phoneNumberId = config.metaPhoneNumberId;
  const token = config.metaWhatsappToken;

  if (!phoneNumberId || !token) {
    throw new Error('Meta WhatsApp Cloud API credentials not configured');
  }

  const chunks = splitMessage(text, 4096);

  for (const chunk of chunks) {
    try {
      const res = await fetch(`${BASE_URL}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: normalizePhone(to),
          type: 'text',
          text: { preview_url: false, body: cleanText(chunk) },
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error('Meta WhatsApp send error:', res.status, JSON.stringify(err));
      }
    } catch (err) {
      console.error('Meta WhatsApp send error:', err.message);
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Receive / parse
// ──────────────────────────────────────────────────────────────

/**
 * Parse an incoming Meta Cloud API webhook payload (JSON body).
 * Returns null if this isn't a valid user message.
 * @param {object} body - req.body from Express (JSON parsed)
 */
export function parseMessage(body) {
  try {
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (!value || value.messaging_product !== 'whatsapp') return null;

    // Status updates (sent, delivered, read) — not user messages
    if (value.statuses) return null;

    const message = value.messages?.[0];
    if (!message) return null;

    const contact = value.contacts?.[0];

    return {
      from: message.from,                         // e.g. '5212345678901'
      name: contact?.profile?.name || null,
      messageId: message.id || null,
      timestamp: message.timestamp ? parseInt(message.timestamp, 10) * 1000 : Date.now(),
      type: message.type || 'text',                // text, image, audio, document, etc.
      text: message.text?.body || message.caption || null,
      // Preserve raw message for media handling later
      _raw: message,
    };
  } catch (err) {
    console.error('Error parsing Meta webhook:', err.message);
    return null;
  }
}

/**
 * Webhook verification handler (GET request from Meta).
 * Mount as: app.get('/webhook', verifyWebhook);
 */
export function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.metaVerifyToken) {
    console.log('Meta webhook verified');
    return res.status(200).send(challenge);
  }

  console.warn('Meta webhook verification failed');
  return res.sendStatus(403);
}

/**
 * Mark a message as read (sends blue ticks).
 * @param {string} messageId - The wamid from parseMessage
 */
export async function markAsRead(messageId) {
  const phoneNumberId = config.metaPhoneNumberId;
  const token = config.metaWhatsappToken;

  if (!phoneNumberId || !token || !messageId) return;

  try {
    await fetch(`${BASE_URL}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      }),
    });
  } catch (err) {
    console.error('Mark-as-read error:', err.message);
  }
}

// ──────────────────────────────────────────────────────────────
// Helpers (shared with Twilio version)
// ──────────────────────────────────────────────────────────────

function cleanText(text) {
  return text
    .replace(/¿/g, '')
    .replace(/¡/g, '')
    .replace(/—/g, ',')
    .replace(/\bcuate\b/gi, 'amigo')
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2702}-\u{27B0}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizePhone(phone) {
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('521') && digits.length === 13) {
    digits = '52' + digits.slice(3);
  }
  return digits;
}

function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf('\n', maxLength);
    if (splitIndex < maxLength * 0.5) {
      splitIndex = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIndex < maxLength * 0.5) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}
