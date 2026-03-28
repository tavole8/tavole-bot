# Tavole — AI WhatsApp Concierge Bot

An AI-powered WhatsApp concierge bot built with Node.js, Meta WhatsApp Cloud API, and Anthropic Claude.

## Features

- 🤖 **AI Chat** — Conversational AI powered by Claude (Haiku for free chat, Sonnet for paid work)
- 💬 **WhatsApp Integration** — Native WhatsApp messaging via Meta Cloud API
- 🎁 **50 Free Messages** — Lifetime free trial for new users
- 💳 **Credit System** — Pay-as-you-go credits via MercadoPago ($100 MXN ≈ 2,000 messages)
- 💰 **Pricing Tiers** — Automated quoting with 4 pricing tiers for dev work (Simple, Standard, Complex, Custom)
- 🔄 **Quote Workflow** — State machine for quote → confirm → work → deliver
- 📋 **Token Tracking** — Per-job token usage with automatic tier limit enforcement
- 🆕 **New User Welcome** — Auto-sends welcome message with privacy notice
- 📜 **Legal Compliance** — LFPDPPP privacy notice + PROFECO-compliant terms of service
- 💾 **SQLite Storage** — Conversation history, user data, credits, job states, cost tracking

## Credit System

| | |
|---|---|
| Free messages | 50 (lifetime) |
| Credit pack | $100 MXN ≈ 2,000 messages |
| Cost per message | ~$0.05 MXN |
| Subscription | None — pay as you go |
| Payment | MercadoPago Checkout Pro |

### How it works

1. New users get 50 free messages to try the service
2. After free messages are used, the bot prompts users to buy credits
3. Credits are deducted per message ($0.05 MXN each)
4. When credits run low (< $5 MXN), the bot warns the user
5. Payments are processed via MercadoPago webhook

## Pricing Tiers (Development Work)

| Tier | Price | Description | Token Limit |
|------|-------|-------------|-------------|
| Simple | $300 MXN | Quick tasks, scripts, text content | 100K |
| Standard | $800 MXN | Websites, landing pages, simple bots | 500K |
| Complex | $2,000 MXN | Full apps, complex automations | 1.5M |
| Custom | $3,000+ MXN | Special projects (human review) | 3M |

## Setup

### 1. Meta WhatsApp Cloud API

1. Create a [Meta Developer](https://developers.facebook.com/) app
2. Add the **WhatsApp** product to your app
3. In the WhatsApp section, get your:
   - **Phone Number ID** — the ID of your WhatsApp business phone number
   - **Access Token** — a permanent system user token (or temporary test token)
4. Configure the webhook URL to `https://your-domain/webhook`
5. Set the **Verify Token** to match your `WHATSAPP_VERIFY_TOKEN` env var (default: `tavole_webhook_2026`)
6. Subscribe to the `messages` webhook field

### 2. Install & Run

```bash
npm install
cp .env.example .env
# Edit .env with your actual credentials
npm start
```

### 3. Webhook Setup

Your server must be publicly accessible (use ngrok for local dev, or deploy to Railway/Render/etc.).

Meta will send a GET request to verify the webhook, then POST requests for incoming messages.

```
GET  /webhook  → Meta webhook verification
POST /webhook  → Incoming WhatsApp messages
```

## Architecture

```
index.js      — Express server, webhook handler, credit flow + state machine
ai.js         — Claude API integration, multi-model routing, system prompts
db.js         — SQLite database (users, messages, credits, jobs, costs)
config.js     — Environment config with validation
payments.js   — MercadoPago integration (payment links + webhooks)
pricing.js    — Pricing tiers, job classification, quote formatting
whatsapp.js   — Meta WhatsApp Cloud API message sending/parsing/verification
legal/        — Privacy notice & terms of service (Spanish, Mexico law)
```

## Multi-Model Routing

- **Free chat** (general questions, small tasks): Uses `claude-haiku-4-5` (~$0.001/call)
- **Paid work** (big asks, confirmed projects): Uses `claude-sonnet-4-5` (~$0.003/call)

## Message Flow

```
User sends message
  ├─ Free messages remaining? → Serve for free
  ├─ Has credits? → Deduct $0.05 MXN, serve
  │   └─ Credits low? → Append warning to reply
  └─ No credits? → Send "buy credits" message with MercadoPago link
```

## Quote Workflow

1. User sends a "big ask" (e.g., "hazme una página web")
2. Bot classifies the request into a pricing tier
3. Bot sends AI response + official quote with price
4. User confirms ("sí") or cancels ("no")
5. On confirm: job moves to `in_progress`, tokens are tracked
6. If token limit exceeded: job pauses, user notified to upgrade

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WHATSAPP_ACCESS_TOKEN` | ✅ | — | Meta WhatsApp Cloud API access token |
| `WHATSAPP_PHONE_NUMBER_ID` | ✅ | — | Meta WhatsApp phone number ID |
| `WHATSAPP_VERIFY_TOKEN` | ❌ | `tavole_webhook_2026` | Webhook verification token |
| `WHATSAPP_APP_SECRET` | ❌ | — | App secret for signature verification |
| `AI_API_KEY` | ✅ | — | AI API key (OpenRouter or Anthropic) |
| `AI_BASE_URL` | ❌ | `https://api.anthropic.com` | AI API base URL |
| `FREE_MESSAGES` | ❌ | 50 | Lifetime free messages per user |
| `CREDIT_PRICE_MXN` | ❌ | 100 | Price per credit pack in MXN |
| `CREDIT_MESSAGES` | ❌ | 2000 | Messages per credit pack |
| `COST_PER_MESSAGE_MXN` | ❌ | 0.05 | Cost per message in MXN |
| `MERCADOPAGO_ACCESS_TOKEN` | ❌ | — | MercadoPago access token |
| `PRIVACY_NOTICE_URL` | ❌ | tavole.ai/privacidad | Privacy notice URL |
| `TERMS_OF_SERVICE_URL` | ❌ | tavole.ai/terminos | Terms of service URL |
| `PORT` | ❌ | 3100 | Server port |

## Legal

- **Privacy Notice**: `legal/privacy-notice.md` — Compliant with Mexico's LFPDPPP
- **Terms of Service**: `legal/terms-of-service.md` — Compliant with PROFECO guidelines

## License

Proprietary — Tavole AI
