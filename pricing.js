/**
 * Tavole — Pricing tiers and job classification.
 * All prices in MXN. Token limits per job.
 */

export const TIERS = {
  simple: {
    name: 'Simple',
    price_mxn: 300,
    description: 'Tareas rápidas, scripts sencillos, contenido de texto.',
    max_tokens: 100_000,
    examples: [
      'Un script para renombrar archivos',
      'Texto para redes sociales',
      'Un correo formal redactado',
      'Una fórmula de Excel compleja',
      'Un mensaje de bienvenida para WhatsApp',
    ],
  },
  standard: {
    name: 'Estándar',
    price_mxn: 800,
    description: 'Sitios web, landing pages, bots sencillos.',
    max_tokens: 500_000,
    examples: [
      'Landing page para tu negocio',
      'Bot de WhatsApp básico',
      'Página web de una sección',
      'Formulario de contacto con backend',
      'Dashboard simple con datos',
    ],
  },
  complex: {
    name: 'Complejo',
    price_mxn: 2000,
    description: 'Apps completas, automatizaciones complejas, sitios multi-página.',
    max_tokens: 1_500_000,
    examples: [
      'App web completa con login',
      'Sistema de reservaciones',
      'Tienda en línea básica',
      'Automatización de procesos de negocio',
      'API REST con base de datos',
    ],
  },
  custom: {
    name: 'Personalizado',
    price_mxn: 3000,
    description: 'Proyectos grandes o especiales. Requiere revisión humana.',
    max_tokens: 3_000_000,
    examples: [
      'Plataforma SaaS completa',
      'App móvil con backend',
      'Sistema empresarial complejo',
      'Integración de múltiples APIs',
      'Proyecto con requerimientos especiales',
    ],
  },
};

// Keyword → tier mapping for classification
const TIER_KEYWORDS = {
  custom: [
    'saas', 'plataforma completa', 'sistema empresarial', 'app móvil',
    'app movil', 'mobile app', 'full platform', 'enterprise',
    'marketplace', 'e-commerce completo', 'ecommerce completo',
  ],
  complex: [
    'app completa', 'aplicación completa', 'aplicacion completa',
    'full app', 'complete app', 'sistema de', 'system',
    'tienda en línea', 'tienda en linea', 'online store',
    'automatización compleja', 'automatizacion compleja',
    'multi-page', 'multi página', 'multi pagina', 'dashboard',
    'base de datos', 'database', 'api rest', 'backend completo',
    'login', 'autenticación', 'autenticacion', 'authentication',
    'reservaciones', 'reservations', 'booking',
  ],
  standard: [
    'landing page', 'landing', 'página web', 'pagina web',
    'sitio web', 'website', 'web page', 'bot sencillo',
    'bot simple', 'simple bot', 'basic bot', 'formulario',
    'form', 'blog', 'portafolio', 'portfolio',
  ],
  simple: [
    'script', 'texto', 'text', 'correo', 'email',
    'fórmula', 'formula', 'excel', 'mensaje', 'message',
    'traducción', 'traduccion', 'translation', 'resumen', 'summary',
    'carta', 'letter', 'plantilla', 'template',
  ],
};

/**
 * Classify a job description into a pricing tier.
 * Returns the tier key ('simple', 'standard', 'complex', 'custom').
 */
export function classifyJob(description) {
  const lower = description.toLowerCase();

  // Check from most expensive to least — first match wins
  for (const tierKey of ['custom', 'complex', 'standard', 'simple']) {
    const keywords = TIER_KEYWORDS[tierKey];
    if (keywords.some(kw => lower.includes(kw))) {
      return tierKey;
    }
  }

  // Default to standard if we can't classify
  return 'standard';
}

/**
 * Format a WhatsApp-friendly quote message in Spanish.
 * @param {string} tierKey - Tier key from TIERS
 * @param {string} [jobDescription] - Optional description to include
 * @returns {string}
 */
export function formatQuote(tierKey, jobDescription) {
  const tier = TIERS[tierKey];
  if (!tier) return '❌ Tier no encontrado.';

  const isCustom = tierKey === 'custom';
  const priceText = isCustom
    ? `$${tier.price_mxn.toLocaleString('es-MX')}+ MXN`
    : `$${tier.price_mxn.toLocaleString('es-MX')} MXN`;

  let msg = `📋 *Cotización Tavole*\n\n`;

  if (jobDescription) {
    msg += `📝 *Proyecto:* ${jobDescription}\n\n`;
  }

  msg += `📦 *Tier:* ${tier.name}\n`;
  msg += `💰 *Precio:* ${priceText}\n`;
  msg += `📄 *Incluye:* ${tier.description}\n\n`;

  if (isCustom) {
    msg += `⚠️ Este proyecto requiere revisión por nuestro equipo para darte un precio exacto.\n\n`;
  }

  msg += `✅ Responde *"sí"* para confirmar y empezar.\n`;
  msg += `❌ Responde *"no"* para cancelar.\n\n`;
  msg += `_Los precios incluyen IVA. Entrega estimada: 24-72 hrs según complejidad._`;

  return msg;
}

/**
 * Format a brief tier summary for listing all tiers.
 */
export function formatAllTiers() {
  let msg = `💼 *Servicios Tavole — Precios*\n\n`;

  for (const [key, tier] of Object.entries(TIERS)) {
    const priceText = key === 'custom'
      ? `$${tier.price_mxn.toLocaleString('es-MX')}+`
      : `$${tier.price_mxn.toLocaleString('es-MX')}`;
    msg += `*${tier.name}* — ${priceText} MXN\n`;
    msg += `${tier.description}\n\n`;
  }

  msg += `_Escríbeme lo que necesitas y te doy una cotización personalizada 🚀_`;
  return msg;
}
