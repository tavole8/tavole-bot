import log from './logger.js';

// ── Prompt injection patterns ───────────────────────────────────────
const INJECTION_PATTERNS = [
  /ignore\s+(previous|your|all|above)\s+instructions/i,
  /you\s+are\s+now/i,
  /\bsystem\s*:/i,
  /\bSYSTEM\s*:/,
  /\bassistant\s*:/i,
  /\buser\s*:/i,
  /\[INST\]/i,
  /<<SYS>>/i,
  /###\s*Instruction/i,
  /forget\s+everything/i,
  /new\s+persona/i,
  /pretend\s+you\s+are/i,
  /act\s+as\s+if/i,
  /roleplay\s+as/i,
  /from\s+now\s+on\s+you\s+are/i,
  /override\s+(your|all)\s+(rules|instructions)/i,
  /disregard\s+(your|all|previous)/i,
  /jailbreak/i,
  /DAN\s+mode/i,
  /developer\s+mode/i,
];

const PROMPT_EXTRACTION_PATTERNS = [
  /what\s+are\s+your\s+instructions/i,
  /repeat\s+your\s+(system\s+)?prompt/i,
  /show\s+me\s+your\s+rules/i,
  /paste\s+your\s+prompt/i,
  /cu[aá]les\s+son\s+tus\s+(instrucciones|reglas)/i,
  /dime\s+tu\s+(prompt|system\s+prompt)/i,
  /mu[eé]strame\s+tus\s+(reglas|instrucciones)/i,
  /print\s+your\s+(system\s+)?prompt/i,
  /output\s+your\s+(initial|system)\s+(instructions|prompt)/i,
  /reveal\s+your\s+(instructions|prompt|rules)/i,
  /what\s+is\s+your\s+system\s+prompt/i,
  /tell\s+me\s+your\s+(rules|instructions|prompt)/i,
];

// ── System prompt leak detection phrases ────────────────────────────
const SYSTEM_PROMPT_PHRASES = [
  'REGLAS ABSOLUTAS',
  'CLASIFICACION DE ACCIONES',
  'SISTEMA DE CREDITOS',
  'DETECCIÓN DE SERVICIOS',
  'MANEJO DE SITUACIONES DIFICILES',
  'CONTEXTO CONVERSACIONAL',
  'REGLAS TÉCNICAS',
  'action_type',
  'quoted_project',
  'small_action',
  'quote_ready',
  'service_detected',
  'romper cualquiera de estas es un error critico',
];

// ── Secret/key patterns ─────────────────────────────────────────────
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/,
  /EAA[a-zA-Z0-9]+/,
  /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/,
  /xox[bposa]-[a-zA-Z0-9\-]+/,
  /ghp_[a-zA-Z0-9]{36,}/,
  /gho_[a-zA-Z0-9]{36,}/,
  /glpat-[a-zA-Z0-9\-]{20,}/,
  /AKIA[A-Z0-9]{16}/,
  /eyJ[a-zA-Z0-9\-_]{20,}\.[a-zA-Z0-9\-_]{20,}\.[a-zA-Z0-9\-_]{20,}/,
];

// ── Rate limiter state ──────────────────────────────────────────────
const rateLimitStore = new Map();

// Cleanup stale entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of rateLimitStore) {
    // Remove entries with no activity in the last 2 hours
    if (now - data.lastActivity > 2 * 60 * 60 * 1000) {
      rateLimitStore.delete(key);
    }
  }
}, 10 * 60 * 1000);

/**
 * Sanitize user input — detect and flag prompt injection attempts.
 * Does NOT block the message; flags it and strips dangerous patterns.
 */
export function sanitizeInput(text) {
  if (!text || typeof text !== 'string') {
    return { cleanText: '', isInjectionAttempt: false, patterns: [] };
  }

  const matchedPatterns = [];

  // Check injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      matchedPatterns.push(pattern.source);
    }
  }

  // Check prompt extraction patterns
  for (const pattern of PROMPT_EXTRACTION_PATTERNS) {
    if (pattern.test(text)) {
      matchedPatterns.push(pattern.source);
    }
  }

  const isInjectionAttempt = matchedPatterns.length > 0;

  // Strip dangerous patterns from the text
  let cleanText = text;
  if (isInjectionAttempt) {
    for (const pattern of [...INJECTION_PATTERNS, ...PROMPT_EXTRACTION_PATTERNS]) {
      cleanText = cleanText.replace(pattern, '');
    }
    cleanText = cleanText.replace(/\s{2,}/g, ' ').trim();

    log.info('security_injection_detected', {
      patterns: matchedPatterns,
      originalLength: text.length,
      cleanLength: cleanText.length,
    });
  }

  return { cleanText, isInjectionAttempt, patterns: matchedPatterns };
}

/**
 * Express middleware for per-phone-number rate limiting.
 * Expects the phone number to be extractable from the webhook body.
 */
export function rateLimiter(req, res, next) {
  try {
    // Extract phone from Meta webhook payload
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    if (!message?.from) {
      // No phone number found — let it through (could be a status update)
      return next();
    }

    const phone = message.from;
    const now = Date.now();

    if (!rateLimitStore.has(phone)) {
      rateLimitStore.set(phone, {
        timestamps: [],
        lastActivity: now,
      });
    }

    const data = rateLimitStore.get(phone);
    data.lastActivity = now;

    // Clean old timestamps
    data.timestamps = data.timestamps.filter((t) => now - t < 60 * 60 * 1000);

    // Check hourly limit (30/hour)
    if (data.timestamps.length >= 30) {
      log.info('security_rate_limit', { phone, type: 'hourly', count: data.timestamps.length });
      // We already sent 200 OK in the handler, but for rate limiting
      // we need to intercept before that. Since the handler sends 200 immediately,
      // we flag on req and let the handler check it.
      req.rateLimited = true;
      req.rateLimitPhone = phone;
      return next();
    }

    // Check burst limit (5/minute)
    const recentMinute = data.timestamps.filter((t) => now - t < 60 * 1000);
    if (recentMinute.length >= 5) {
      log.info('security_rate_limit', { phone, type: 'burst', count: recentMinute.length });
      req.rateLimited = true;
      req.rateLimitPhone = phone;
      return next();
    }

    // Record this message
    data.timestamps.push(now);
    next();
  } catch (err) {
    // Don't block on rate limiter errors
    next();
  }
}

/**
 * Filter AI output before sending to the user.
 * Detects system prompt leaks and exposed secrets.
 */
export function filterOutput(text) {
  if (!text || typeof text !== 'string') {
    return { cleanText: '', wasFiltered: false, reason: null };
  }

  const upper = text.toUpperCase();

  // Check for system prompt phrases
  for (const phrase of SYSTEM_PROMPT_PHRASES) {
    if (upper.includes(phrase.toUpperCase())) {
      log.info('security_output_filtered', { reason: 'system_prompt_leak', phrase });
      return {
        cleanText: 'Hmm, algo salio mal. Intentalo de nuevo.',
        wasFiltered: true,
        reason: `system_prompt_leak: ${phrase}`,
      };
    }
  }

  // Check for secrets/keys
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      log.info('security_output_filtered', { reason: 'secret_detected', pattern: pattern.source });
      return {
        cleanText: 'Hmm, algo salio mal. Intentalo de nuevo.',
        wasFiltered: true,
        reason: `secret_detected: ${pattern.source}`,
      };
    }
  }

  return { cleanText: text, wasFiltered: false, reason: null };
}

/**
 * Validate phone number — only allow Mexican numbers.
 */
export function validatePhone(phone) {
  if (!phone || typeof phone !== 'string') return false;

  // Normalize: strip + prefix
  const clean = phone.replace(/^\+/, '');

  // Must start with 52 (Mexico country code)
  if (!clean.startsWith('52')) return false;

  // Mexican numbers: 52 + 10 digits = 12 digits total
  if (!/^52\d{10}$/.test(clean)) return false;

  // Block known test/spam patterns
  const spamPatterns = [
    /^520{10}$/,       // 520000000000
    /^521234567890$/,  // 521234567890
    /^529999999999$/,  // 529999999999
    /^521111111111$/,  // 521111111111
  ];

  for (const pattern of spamPatterns) {
    if (pattern.test(clean)) return false;
  }

  return true;
}
