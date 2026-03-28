/**
 * Tavole v2 — Flexible quoting module for deliverables.
 *
 * Replaces the rigid pricing.js tier system with AI-guided quoting.
 * Keeps tier price ranges as guidelines.
 */

import { createDeliverable } from './db.js';
import { createPaymentLink } from './payments.js';

// Tier guidelines (price ranges in MXN)
export const TIER_GUIDELINES = {
  simple: {
    name: 'Simple',
    price_mxn: 300,
    description: 'Scripts, textos, ediciones menores.',
  },
  standard: {
    name: 'Estandar',
    price_mxn: 800,
    description: 'Paginas web, landings, bots sencillos, dashboards.',
  },
  complex: {
    name: 'Complejo',
    price_mxn: 2000,
    description: 'Apps completas, automatizaciones complejas, sitios multi-pagina.',
  },
  custom: {
    name: 'Personalizado',
    price_mxn: 3000,
    description: 'Proyectos grandes o especiales.',
  },
};

// Map detected categories to default tiers
const CATEGORY_TO_TIER = {
  'website': 'standard',
  'whatsapp-bot': 'standard',
  'automation': 'complex',
  'dashboard': 'complex',
  'design': 'simple',
  'consulting': 'simple',
  'other': 'standard',
};

/**
 * Suggest a tier based on the detected service category.
 *
 * @param {string} category - From intent detection
 * @returns {{ tier: string, price_mxn: number, tierName: string }}
 */
export function suggestTier(category) {
  const tierKey = CATEGORY_TO_TIER[category] || 'standard';
  const tier = TIER_GUIDELINES[tierKey];
  return {
    tier: tierKey,
    price_mxn: tier.price_mxn,
    tierName: tier.name,
  };
}

/**
 * Generate a quote for a deliverable and store it in the database.
 *
 * @param {string} userPhone
 * @param {string} category - Service category
 * @param {string} description - What the user wants built
 * @param {string} [tierOverride] - Optional tier override
 * @returns {Promise<{ deliverable: object, quoteMessage: string, paymentUrl: string }>}
 */
export async function generateQuote(userPhone, category, description, tierOverride) {
  const tierKey = tierOverride || (CATEGORY_TO_TIER[category] || 'standard');
  const tier = TIER_GUIDELINES[tierKey];
  const priceMxn = tier.price_mxn;

  // Create deliverable record
  const deliverable = createDeliverable(
    userPhone,
    category,
    description,
    `${tier.name}: ${tier.description}`,
    priceMxn
  );

  // Generate payment link
  const payment = await createDeliverablePaymentLink(userPhone, deliverable.id, description, priceMxn);

  const priceText = tierKey === 'custom'
    ? `$${priceMxn.toLocaleString('es-MX')}+ MXN`
    : `$${priceMxn.toLocaleString('es-MX')} MXN`;

  const quoteMessage = `*Cotizacion*\n\n` +
    `Proyecto: ${description}\n` +
    `Precio: ${priceText}\n` +
    `Incluye: ${tier.description}\n\n` +
    `Responde "si" para confirmar o "no" para cancelar.\n\n` +
    `Link de pago: ${payment.url}`;

  return { deliverable, quoteMessage, paymentUrl: payment.url };
}

/**
 * Create a MercadoPago payment link for a specific deliverable.
 */
async function createDeliverablePaymentLink(userPhone, deliverableId, description, priceMxn) {
  // Reuse the existing payment infrastructure
  const result = await createPaymentLink(userPhone, {
    title: `Tavole — ${description}`,
    price: priceMxn,
    reference: `deliverable:${deliverableId}:${userPhone}`,
  });
  return result;
}
