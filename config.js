import 'dotenv/config';

const config = {
  // Twilio WhatsApp API (legacy — kept for reference)
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
  twilioWhatsappNumber: process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886',

  // Meta WhatsApp Cloud API
  metaWhatsappToken: process.env.META_WHATSAPP_TOKEN,
  metaPhoneNumberId: process.env.META_PHONE_NUMBER_ID,
  metaVerifyToken: process.env.META_VERIFY_TOKEN || 'tavole_webhook_verify_2026',

  // AI Provider (Anthropic-compatible, e.g. OpenRouter)
  anthropicApiKey: process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY,
  aiBaseUrl: process.env.AI_BASE_URL || 'https://api.anthropic.com',

  // MercadoPago (used for per-deliverable payments)
  mercadoPagoAccessToken: process.env.MERCADOPAGO_ACCESS_TOKEN || '',
  mercadoPagoWebhookSecret: process.env.MERCADOPAGO_WEBHOOK_SECRET || '',
  webhookBaseUrl: process.env.WEBHOOK_BASE_URL || '',

  // Legal / public URLs
  privacyNoticeUrl: process.env.PRIVACY_NOTICE_URL || 'https://tavole.ai/privacidad',
  termsOfServiceUrl: process.env.TERMS_OF_SERVICE_URL || 'https://tavole.ai/terminos',

  // Server
  port: parseInt(process.env.PORT || '3100', 10),
};

// Validate required env vars on startup (warn only — don't exit)
const required = ['metaWhatsappToken', 'metaPhoneNumberId', 'anthropicApiKey'];
for (const key of required) {
  if (!config[key]) {
    console.warn(`⚠️  Missing required env var for: ${key}`);
  }
}

export default config;
