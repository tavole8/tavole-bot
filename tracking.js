import log from './logger.js';

const TIMEOUT_MS = 10000;

/**
 * Detect if a message contains a tracking number and which carrier it belongs to.
 */
export function detectTracking(text) {
  if (!text) return null;
  const clean = text.replace(/\s+/g, ' ').trim();

  // UPS: 1Z...
  const upsMatch = clean.match(/\b(1Z[A-Z0-9]{16})\b/i);
  if (upsMatch) return { carrier: 'ups', trackingNumber: upsMatch[1] };

  // DHL: 10-digit or starts with JD/JJD  
  const dhlMatch = clean.match(/\b(JD\d{18}|JJD\d{17})\b/i);
  if (dhlMatch) return { carrier: 'dhl', trackingNumber: dhlMatch[1] };

  // Estafeta: 22 digits or starts with specific prefixes
  const estafetaMatch = clean.match(/\b(\d{22})\b/);
  if (estafetaMatch) return { carrier: 'estafeta', trackingNumber: estafetaMatch[1] };

  // FedEx: 12-15 digits (most common)
  const fedexMatch = clean.match(/\b(\d{12,15})\b/);
  if (fedexMatch) return { carrier: 'fedex', trackingNumber: fedexMatch[1] };

  // Generic long number (could be any carrier): 10-22 digits
  const genericMatch = clean.match(/\b(\d{10,22})\b/);
  if (genericMatch) return { carrier: 'unknown', trackingNumber: genericMatch[1] };

  return null;
}

/**
 * Generate tracking links for the detected carrier.
 */
function getTrackingLinks(trackingNumber, carrier) {
  const links = {
    fedex: {
      name: 'FedEx',
      url: `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`,
    },
    ups: {
      name: 'UPS',
      url: `https://www.ups.com/track?tracknum=${trackingNumber}`,
    },
    dhl: {
      name: 'DHL',
      url: `https://www.dhl.com/mx-es/home/rastreo.html?tracking-id=${trackingNumber}`,
    },
    estafeta: {
      name: 'Estafeta',
      url: `https://rastreo3.estafeta.com/Tracking/searchByNumber/?guideNumber=${trackingNumber}`,
    },
    unknown: {
      name: 'Paquetería',
      url: `https://parcelsapp.com/en/tracking/${trackingNumber}`,
    },
  };

  return links[carrier] || links.unknown;
}

/**
 * Try to get tracking status via FedEx's internal API.
 * Returns null if it fails (we'll fall back to link-only response).
 */
async function tryFedExAPI(trackingNumber) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    // FedEx's internal tracking endpoint used by their website
    const res = await fetch('https://www.fedex.com/trackingCal/track', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'es-MX,es;q=0.9',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: new URLSearchParams({
        data: JSON.stringify({
          TrackPackagesRequest: {
            appType: 'WTRK',
            uniqueKey: '',
            processingParameters: {},
            trackingInfoList: [{
              trackNumberInfo: {
                trackingNumber,
                trackingQualifier: '',
                trackingCarrier: '',
              }
            }]
          }
        }),
        action: 'trackpackages',
        locale: 'es_MX',
        version: '1',
        format: 'json',
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) return null;

    const text = await res.text();
    // Check if it's actually JSON
    if (text.startsWith('<') || text.startsWith('<!')) return null;

    const data = JSON.parse(text);
    const pkg = data?.TrackPackagesResponse?.packageList?.[0];

    if (!pkg || pkg.errorList?.length > 0) return null;

    return {
      status: pkg.keyStatus || null,
      statusDetail: pkg.keyStatusCD || null,
      estimatedDelivery: pkg.displayEstDeliveryDt || null,
      actualDelivery: pkg.displayActDeliveryDt || null,
      origin: pkg.originCity ? `${pkg.originCity}, ${pkg.originCntryCD}` : null,
      destination: pkg.destCity ? `${pkg.destCity}, ${pkg.destCntryCD}` : null,
      events: (pkg.scanEventList || []).slice(0, 5).map(e => ({
        date: e.date || '',
        time: e.time || '',
        location: e.scanLocation || '',
        description: e.status || '',
      })),
    };
  } catch (err) {
    log.info('tracking_fedex_api_error', { trackingNumber, error: err.message });
    return null;
  }
}

/**
 * Track a package. Returns formatted tracking info string for the AI.
 */
export async function trackPackage(trackingNumber, carrier = 'fedex') {
  const link = getTrackingLinks(trackingNumber, carrier);
  
  // Try to get real status data
  let apiResult = null;
  if (carrier === 'fedex') {
    apiResult = await tryFedExAPI(trackingNumber);
  }

  let formatted = `RESULTADO DE RASTREO:\n`;
  formatted += `Paqueteria: ${link.name}\n`;
  formatted += `Numero de guia: ${trackingNumber}\n`;
  formatted += `Link de rastreo: ${link.url}\n`;

  if (apiResult && apiResult.status) {
    formatted += `Estado: ${apiResult.status}\n`;
    if (apiResult.statusDetail) formatted += `Detalle: ${apiResult.statusDetail}\n`;
    if (apiResult.estimatedDelivery) formatted += `Entrega estimada: ${apiResult.estimatedDelivery}\n`;
    if (apiResult.actualDelivery) formatted += `Entregado: ${apiResult.actualDelivery}\n`;
    if (apiResult.origin) formatted += `Origen: ${apiResult.origin}\n`;
    if (apiResult.destination) formatted += `Destino: ${apiResult.destination}\n`;

    if (apiResult.events && apiResult.events.length > 0) {
      formatted += `\nHistorial reciente:\n`;
      for (const e of apiResult.events) {
        formatted += `- ${e.date} ${e.time} | ${e.location} | ${e.description}\n`;
      }
    }

    formatted += `\nResponde con el estado del paquete. Incluye el link de rastreo para que el usuario pueda ver mas detalles.`;
  } else {
    formatted += `Estado: No se pudo consultar automaticamente.\n`;
    formatted += `\nIMPORTANTE: No pudiste obtener el estado exacto por API. Responde al usuario con el LINK de rastreo para que pueda verlo directamente. Dile algo como "Aqui puedes ver el estado de tu paquete: [link]". NO digas que no encontraste informacion — dale el link directo.`;
  }

  return { formatted, raw: apiResult };
}
