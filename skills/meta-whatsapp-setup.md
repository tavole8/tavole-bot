# Meta WhatsApp Cloud API Setup

## What this skill covers
Setting up a WhatsApp bot for a client using Meta's free Cloud API with a prepaid SIM chip.

## Prerequisites
- A phone number not currently registered on WhatsApp
- Access to a phone to receive SMS verification
- A Facebook account for Meta Developer access

## Cost
- SIM chip: ~$79 MXN (one-time, includes $50 credit)
- Meta Cloud API: FREE for first 1,000 conversations/month
- Annual number maintenance: ~$50 MXN recharge to keep number alive

## Step-by-Step Process

### Step 1: Get a phone number
- Buy a prepaid SIM at OXXO ($79 MXN for Telcel with $50 credit)
- Insert in any phone to activate
- Note the phone number from the packaging
- The number must NOT be registered on WhatsApp already

### Step 2: Create Meta Developer App
- Go to developers.facebook.com
- Log in with Facebook account
- Click "My Apps" > "Create App"
- Choose "Business" type
- Name the app (e.g., client's business name)
- In the dashboard, click "Add Product" > find "WhatsApp" > "Set Up"

### Step 3: Get API credentials
- In WhatsApp section, go to "API Setup"
- You'll see:
  - Phone Number ID (a number like 1044405612090155)
  - Temporary Access Token (starts with EAAR...)
- IMPORTANT: Temporary tokens expire in ~1 hour. Set up a permanent token (see below).

### Step 4: Add recipient to allowed list
- In API Setup, Step 2, add the test recipient's phone number
- Meta will send a verification code via SMS
- Enter the code to verify
- Without this step, the bot can send but recipients won't receive messages

### Step 5: Configure webhook
- In API Setup, find "Configure Webhooks" (Step 3)
- Callback URL: your server's public URL + /webhook (e.g., https://your-domain.trycloudflare.com/webhook)
- Verify Token: a secret string you define (e.g., "tavole_webhook_2026")
- Subscribe to "messages" field
- The server must respond to GET /webhook with the hub.challenge for verification

### Step 6: Register the real phone number
- In WhatsApp section, click "Add Phone Number"
- Enter the prepaid SIM number
- Choose SMS verification
- Insert the SIM in a phone, receive the code
- Enter the code in Meta's dashboard
- The number is now registered as a WhatsApp Business number

## Common Errors & Solutions

### "Recipient phone number not in allowed list"
- The recipient needs to be added in API Setup Step 2
- For production (after Meta Business verification), this restriction is lifted

### Mexican phone number format
- Meta webhook sends numbers as: 5212299608490 (with extra 1 after country code)
- Meta API expects: 522299608490 (without the extra 1)
- Solution: Strip the extra 1 for Mexican numbers in the send function:
  if number starts with "521" and has 13 digits, change to "52" + last 10 digits

### Token expired
- Temporary tokens last ~1 hour
- For production: create a System User in Meta Business Manager > generate permanent token
- The permanent token needs whatsapp_business_messaging permission

### Webhook verification fails
- Make sure the verify token matches exactly
- The server must return the hub.challenge value as plain text, not JSON
- Common issue: URL has a typo or space in it

## Telcel SIM Maintenance
- Recharge at least $50 MXN once per year to keep the number active
- After ~1 year without recharge, number gets recycled
- Can recharge online via Telcel app or MercadoPago

## Pricing for clients
- Option A: Client buys their own chip ($0/month) — we walk them through setup
- Option B: We handle everything with Twilio ($150 MXN/month) — instant, no paperwork for client
- Mexican Twilio numbers require regulatory compliance (ID documents, 1-3 day approval)
- US Twilio numbers are instant ($1.15/month) but less local trust

## Architecture
WhatsApp User → Meta Cloud API → Cloudflare Tunnel → Node.js Bot → OpenRouter API → Claude → Reply
