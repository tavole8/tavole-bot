import log from './logger.js';

const TIMEOUT_MS = 10000;

/**
 * Detect if a message contains a tracking number and which carrier it belongs to.
 */
export function detectTracking(text) {
  if (!text) return null;
  const clean = text.replace(/\s+/g, ' ').trim();

  // FedEx: 12-22 digits
  const fedexMatch = clean.match(/\b(\d{12,22})\b/);
  if (fedexMatch) {
    const num = fedexMatch[1];
    // FedEx tracking numbers are typically 12, 15, 20, or 22 digits
    if ([12, 15, 20, 22].includes(num.length) || num.length >= 12) {
      return { carrier: 'fedex', trackingNumber: num };
    }
  }

  // DHL: 10-digit or starts with JD/JJD
  const dhlMatch = clean.match(/\b(JD\d{18}|JJD\d{17}|\d{10})\b/i);
  if (dhlMatch) return { carrier: 'dhl', trackingNumber: dhlMatch[1] };

  // UPS: 1Z...
  const upsMatch = clean.match(/\b(1Z[A-Z0-9]{16})\b/i);
  if (upsMatch) return { carrier: 'ups', trackingNumber: upsMatch[1] };

  return null;
}

/**
 * Track a FedEx package using their public tracking API.
 */
async function trackFedEx(trackingNumber) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    // Use FedEx's public tracking endpoint (no API key needed)
    const res = await fetch('https://www.fedex.com/fedextrack/summary/json', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      body: JSON.stringify({
        TrackPackagesRequest: {
          appType: 'WTRK',
          uniqueKey: '',
          processingParameters: {},
          trackingInfoList: [{
            trackNumberInfo: { trackingNumber, trackingQualifier: '', trackingCarrier: '' }
          }]
        }
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      // Fallback: try 17track API (free, no key)
      return await trackVia17Track(trackingNumber);
    }

    const data = await res.json();
    const pkg = data?.TrackPackagesResponse?.packageList?.[0];

    if (!pkg || pkg.errorList?.length > 0) {
      return await trackVia17Track(trackingNumber);
    }

    return {
      carrier: 'FedEx',
      trackingNumber,
      status: pkg.keyStatus || 'Desconocido',
      statusDetail: pkg.keyStatusCD || '',
      lastUpdate: pkg.displayActDeliveryDt || pkg.displayEstDeliveryDt || '',
      origin: pkg.originCity ? `${pkg.originCity}, ${pkg.originCntryCD}` : '',
      destination: pkg.destCity ? `${pkg.destCity}, ${pkg.destCntryCD}` : '',
      events: (pkg.scanEventList || []).slice(0, 5).map(e => ({
        date: e.date || '',
        time: e.time || '',
        location: e.scanLocation || '',
        description: e.status || '',
      })),
    };
  } catch (err) {
    log.info('tracking_fedex_error', { trackingNumber, error: err.message });
    return await trackVia17Track(trackingNumber);
  }
}

/**
 * Fallback: use 17track's public page scraping
 */
async function trackVia17Track(trackingNumber) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    // Try Parcelsapp public API
    const res = await fetch(`https://parcelsapp.com/api/v3/shipments/tracking`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        shipments: [{ trackingId: trackingNumber, language: 'es', country: 'Mexico' }],
        language: 'es',
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      return { carrier: 'Unknown', trackingNumber, status: 'No se pudo consultar el estado', events: [] };
    }

    const data = await res.json();
    const shipment = data?.shipments?.[0];

    if (shipment) {
      return {
        carrier: shipment.carrier || 'Unknown',
        trackingNumber,
        status: shipment.status || 'En transito',
        lastUpdate: shipment.lastUpdate || '',
        events: (shipment.events || []).slice(0, 5).map(e => ({
          date: e.date || '',
          location: e.location || '',
          description: e.description || '',
        })),
      };
    }

    return { carrier: 'Unknown', trackingNumber, status: 'Sin informacion disponible', events: [] };
  } catch (err) {
    log.info('tracking_17track_error', { trackingNumber, error: err.message });
    return { carrier: 'Unknown', trackingNumber, status: 'Error al consultar rastreo', events: [] };
  }
}

/**
 * Track a package. Returns formatted tracking info string for the AI.
 */
export async function trackPackage(trackingNumber, carrier = 'fedex') {
  let result;

  switch (carrier) {
    case 'fedex':
      result = await trackFedEx(trackingNumber);
      break;
    default:
      result = await trackVia17Track(trackingNumber);
  }

  // Format for AI consumption
  let formatted = `RESULTADO DE RASTREO:\n`;
  formatted += `Paqueteria: ${result.carrier}\n`;
  formatted += `Numero: ${result.trackingNumber}\n`;
  formatted += `Estado: ${result.status}\n`;
  if (result.statusDetail) formatted += `Detalle: ${result.statusDetail}\n`;
  if (result.lastUpdate) formatted += `Ultima actualizacion: ${result.lastUpdate}\n`;
  if (result.origin) formatted += `Origen: ${result.origin}\n`;
  if (result.destination) formatted += `Destino: ${result.destination}\n`;

  if (result.events && result.events.length > 0) {
    formatted += `\nHistorial (ultimos ${result.events.length} movimientos):\n`;
    for (const e of result.events) {
      formatted += `- ${e.date || ''} ${e.time || ''} | ${e.location || ''} | ${e.description || ''}\n`;
    }
  }

  return { formatted, raw: result };
}
