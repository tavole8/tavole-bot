# Bot v2 Refactor Spec — General Concierge Mode

*Created: 2026-03-21 | Status: Draft*

## Overview

Transform the current vertical SaaS bot (credit-based, multi-tier pricing) into a single-number general AI concierge. The user messages, chats freely, and we detect when they want something built/done — then quote, collect, deliver.

## Key Changes from v1

| Area | v1 (Current) | v2 (Target) |
|------|-------------|-------------|
| Conversation model | Credit-gated (50 free, then pay) | Free unlimited chat |
| Revenue trigger | Message count exhaustion | User requests a deliverable |
| AI persona | Task-specific assistant | General concierge (curious, helpful, proactive) |
| Service detection | Manual tier classification | AI-driven intent detection mid-conversation |
| Payment flow | Credit packs ($100 MXN) | Per-deliverable quotes via MercadoPago |
| Onboarding | Welcome + credit explanation | Welcome + "ask me anything" |

## Architecture Changes

### 1. Remove Credit Gating
- **Delete:** `FREE_MESSAGE_LIMIT`, `hasCredits()`, `deductCredit()` checks in message flow
- **Keep:** `db.js` user tracking (we still want to know who's messaging)
- **Keep:** Conversation logging (critical for learning what people ask for)

### 2. New Conversation Flow
```
User sends message
  → Parse & log
  → Get/create user (no credit check)
  → Build conversation history (last 20 messages)
  → Send to Claude with v2 system prompt
  → Claude responds naturally
  → IF Claude detects a service opportunity → tag it in response metadata
  → IF user confirms interest → generate quote → MercadoPago link
  → IF payment received → create job → deliver
```

### 3. AI System Prompt (v2 Core)
```
You are Yajalo, a friendly AI concierge on WhatsApp. You help anyone with anything — 
questions, recommendations, translations, calculations, brainstorming. You're casual, 
warm, and Mexican-flavored (but not forced).

When someone describes a problem that could be solved with a digital deliverable 
(website, bot, automation, dashboard, design), naturally explore their need. Don't 
hard-sell — be genuinely helpful first. If the need is real, mention that you can 
build it for them and offer to send a quote.

NEVER:
- Mention credits, message limits, or payment unless offering a deliverable
- Be robotic or corporate
- Refuse reasonable requests (within legal/ethical bounds)

DETECT SERVICE OPPORTUNITIES:
If the user's message implies they need something BUILT (not just answered), add a 
JSON tag at the end of your response: {"service_detected": true, "category": "..."}
Categories: website, whatsapp-bot, automation, dashboard, design, consulting, other
```

### 4. New Files / Modules

#### `intent.js` — Service Intent Detection
- Post-process Claude responses for `service_detected` tags
- Track conversation state: `chatting` → `exploring_need` → `quoting` → `awaiting_payment` → `in_progress` → `delivered`
- Store state in SQLite per user

#### `quotes.js` — Dynamic Quoting (replaces `pricing.js`)
- Based on detected category + conversation context
- AI-assisted scope estimation
- Output: description, price, timeline, MercadoPago link
- Keep tier structure as guidelines: Simple ~$300 / Standard ~$800 / Complex ~$2,000 / Custom $3,000+

### 5. Database Schema Changes
```sql
-- Add to users table
ALTER TABLE users ADD COLUMN conversation_state TEXT DEFAULT 'chatting';
ALTER TABLE users ADD COLUMN last_service_detected TEXT;

-- New table: deliverables (replaces credit-based jobs)
CREATE TABLE deliverables (
  id INTEGER PRIMARY KEY,
  user_phone TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  scope_summary TEXT,
  price_mxn INTEGER,
  status TEXT DEFAULT 'quoted', -- quoted, paid, in_progress, delivered, cancelled
  mercadopago_id TEXT,
  quoted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  paid_at DATETIME,
  delivered_at DATETIME,
  FOREIGN KEY (user_phone) REFERENCES users(phone)
);
```

### 6. What to Keep As-Is
- `whatsapp.js` / `whatsapp-meta.js` — transport layer unchanged
- `config.js` — add new env vars, keep existing
- Express server structure
- Cloudflare Tunnel setup
- MercadoPago integration (adapt for per-deliverable payments)

## Migration Path
1. **Phase 1 (now):** Write v2 system prompt + intent detection. Keep credit system but set limit to 999999.
2. **Phase 2 (pre-alpha):** Remove credit UI entirely. Add `deliverables` table. Wire up quoting flow.
3. **Phase 3 (alpha):** Full v2 with MercadoPago per-deliverable. Deploy to OXXO SIM number.

## Open Questions
- [ ] Brand name: Tavole vs Yajalo vs TBD (waiting on Scout research)
- [ ] Should free chat have any daily message cap to prevent abuse? (Suggest: no cap for alpha, monitor costs)
- [ ] Voice message support — defer or include in alpha?
- [ ] MercadoPago: reuse existing integration or rebuild for per-item flow?

## Estimated Effort
- Phase 1: 2-3 hours (prompt + intent module)
- Phase 2: 4-6 hours (DB migration, quote flow, UI removal)  
- Phase 3: 3-4 hours (payment wiring, testing)
- **Total: ~10-13 hours of coding work** → good candidate for Claude Code session
