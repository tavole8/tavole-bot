/**
 * Tavole v2 — Service intent detection & conversation state management.
 *
 * Parses AI responses for service_detected JSON tags and manages
 * the user's conversation state flow.
 */

import {
  updateConversationState,
  updateLastServiceDetected,
  getOrCreateUser,
} from './db.js';

const VALID_CATEGORIES = [
  'website', 'whatsapp-bot', 'automation', 'dashboard',
  'design', 'consulting', 'other',
];

// Regex to find the service detection JSON tag at the end of a response
const SERVICE_TAG_REGEX = /\{"service_detected"\s*:\s*true\s*,\s*"category"\s*:\s*"([^"]+)"\s*\}\s*$/;

// Regex for quote-ready tag: AI signals it has enough info to generate a formal quote
const QUOTE_READY_REGEX = /\{"quote_ready"\s*:\s*true\s*,\s*"category"\s*:\s*"([^"]+)"\s*,\s*"description"\s*:\s*"([^"]+)"\s*,\s*"tier"\s*:\s*"([^"]+)"\s*\}\s*$/;

/**
 * Parse an AI response for service intent tags or quote-ready tags.
 * Returns { cleanResponse, intent, quoteRequest } where:
 *   - intent is null or { category } (service detected)
 *   - quoteRequest is null or { category, description, tier } (ready to quote)
 *
 * @param {string} aiResponse - Raw AI response text
 * @returns {{ cleanResponse: string, intent: { category: string } | null, quoteRequest: { category: string, description: string, tier: string } | null }}
 */
export function parseIntent(aiResponse) {
  // Check for quote-ready tag first (more specific)
  const quoteMatch = aiResponse.match(QUOTE_READY_REGEX);
  if (quoteMatch) {
    const category = quoteMatch[1];
    const description = quoteMatch[2];
    const tier = quoteMatch[3];
    const cleanResponse = aiResponse.slice(0, quoteMatch.index).trimEnd();
    return { cleanResponse, intent: null, quoteRequest: { category, description, tier } };
  }

  // Check for service detection tag
  const match = aiResponse.match(SERVICE_TAG_REGEX);
  if (!match) {
    return { cleanResponse: aiResponse, intent: null, quoteRequest: null };
  }

  const category = match[1];
  const cleanResponse = aiResponse.slice(0, match.index).trimEnd();

  if (!VALID_CATEGORIES.includes(category)) {
    return { cleanResponse, intent: { category: 'other' }, quoteRequest: null };
  }

  return { cleanResponse, intent: { category }, quoteRequest: null };
}

/**
 * Process a detected service intent — update user state and service category.
 *
 * @param {string} userPhone
 * @param {{ category: string }} intent
 */
export function processIntent(userPhone, intent) {
  updateConversationState(userPhone, 'exploring_need');
  updateLastServiceDetected(userPhone, intent.category);
  console.log(`[INTENT] ${userPhone} — service detected: ${intent.category}`);
}

/**
 * Transition a user's conversation state.
 *
 * Valid transitions:
 *   chatting → exploring_need (service detected)
 *   exploring_need → quoting (quote generated)
 *   quoting → awaiting_payment (payment link sent)
 *   awaiting_payment → in_progress (payment received)
 *   in_progress → delivered (deliverable complete)
 *   any → chatting (reset, e.g. after cancel)
 *
 * @param {string} userPhone
 * @param {string} newState
 */
export function transitionState(userPhone, newState) {
  updateConversationState(userPhone, newState);
  console.log(`[STATE] ${userPhone} → ${newState}`);
}

/**
 * Get the current conversation state for a user.
 *
 * @param {string} userPhone
 * @returns {string}
 */
export function getConversationState(userPhone) {
  const { user } = getOrCreateUser(userPhone);
  return user.conversation_state || 'chatting';
}
