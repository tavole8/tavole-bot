import config from './config.js';
import twilio from 'twilio';

// Initialize Twilio client
const client = twilio(config.twilioAccountSid, config.twilioAuthToken);

/**
 * Send a text message via Twilio WhatsApp API.
 * @param {string} to - Phone number (e.g. '521234567890')
 * @param {string} text - Message body
 */
export async function sendMessage(to, text) {
  // WhatsApp has a ~4096 char limit, but we keep 1600 for readability
  const chunks = splitMessage(text, 1600);

  for (const chunk of chunks) {
    try {
      await client.messages.create({
        from: config.twilioWhatsappNumber,  // 'whatsapp:+14155238886'
        to: `whatsapp:+${normalizePhone(to)}`,
        body: cleanText(chunk),
      });
    } catch (err) {
      console.error('Twilio WhatsApp send error:', err.message);
    }
  }
}

/**
 * Parse an incoming Twilio WhatsApp webhook payload (application/x-www-form-urlencoded).
 * Returns null if this isn't a valid user message.
 * @param {object} body - req.body from Express (parsed by urlencoded middleware)
 */
export function parseMessage(body) {
  try {
    if (!body || !body.Body || !body.From) return null;

    // Twilio sends From as 'whatsapp:+521234567890'
    const from = body.From.replace('whatsapp:+', '');

    return {
      from,
      name: body.ProfileName || null,
      messageId: body.MessageSid || null,
      timestamp: Date.now(),
      type: body.NumMedia && parseInt(body.NumMedia, 10) > 0 ? 'media' : 'text',
      text: body.Body || null,
    };
  } catch (err) {
    console.error('Error parsing webhook:', err.message);
    return null;
  }
}

/**
 * Validate incoming Twilio webhook signature.
 * Call this middleware before processing webhooks in production.
 */
export function validateTwilioSignature(req, res, next) {
  if (!config.twilioAuthToken) {
    // Skip validation if no auth token (dev mode)
    return next();
  }

  const signature = req.headers['x-twilio-signature'];
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

  const isValid = twilio.validateRequest(
    config.twilioAuthToken,
    signature,
    url,
    req.body
  );

  if (isValid) {
    return next();
  }

  console.warn('Twilio signature validation failed');
  return res.status(403).send('Forbidden');
}

/**
 * Clean outgoing text: remove ¿, ¡, —, and excessive emojis.
 */
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

/**
 * Normalize phone number.
 * Mexican mobile numbers: strip extra 1 if present (521XXXXXXXXX → 52XXXXXXXXX).
 */
function normalizePhone(phone) {
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('521') && digits.length === 13) {
    digits = '52' + digits.slice(3);
  }
  return digits;
}

/**
 * Split a long message into chunks that fit the limit.
 */
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
