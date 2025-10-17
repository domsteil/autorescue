export function mapDatasetItemToIncident(item, { minDelayHours = 24 } = {}) {
  if (!item) return null;
  const delayHoursRaw =
    item.delayHours ?? item.delay_hours ?? item.delay ?? item.delay_hours_estimate;
  const delayHours = Number(delayHoursRaw);
  if (!Number.isFinite(delayHours) || delayHours < minDelayHours) {
    return null;
  }

  const orderId = item.orderId ?? item.order_id ?? item.orderNumber;
  if (!orderId) return null;

  const incidentId =
    item.incidentId ??
    item.incident_id ??
    item.id ??
    item.trackingNumber ??
    `APIFY-${orderId}-${Date.now()}`;

  const promisedDelivery =
    item.promisedDeliveryDate ??
    item.promised_delivery ??
    item.promised_delivery_date;

  const carrierStatus = {
    code:
      item.carrierStatusCode ??
      item.statusCode ??
      item.status_code ??
      'DELAYED',
    description:
      item.carrierStatusDescription ??
      item.statusDescription ??
      item.status_description ??
      'Carrier reported delay.',
    estimatedDelivery:
      item.estimatedDelivery ??
      item.eta ??
      item.estimated_delivery ??
      item.estimated_delivery_date,
  };

  const incident = {
    incidentId: String(incidentId),
    type: 'shipment_delay',
    orderId: String(orderId),
    detectedAt: item.detectedAt ?? item.detected_at ?? new Date().toISOString(),
    carrierStatus,
    promisedDeliveryDate: promisedDelivery,
    delayHours,
    source: item.source ?? 'apify-actor',
  };

  if (item.environment) {
    incident.environment = item.environment;
  }
  if (item.region) {
    incident.region = item.region;
  }
  incident.raw = sanitizeRawItem(item);

  return incident;
}

function sanitizeRawItem(item) {
  const raw = {};
  for (const [key, value] of Object.entries(item)) {
    if (
      [
        'delayHours',
        'delay_hours',
        'delay',
        'delay_hours_estimate',
        'orderId',
        'order_id',
        'incidentId',
        'incident_id',
        'id',
        'trackingNumber',
        'promisedDeliveryDate',
        'promised_delivery',
        'promised_delivery_date',
        'carrierStatusCode',
        'statusCode',
        'status_code',
        'carrierStatusDescription',
        'statusDescription',
        'status_description',
        'estimatedDelivery',
        'eta',
        'estimated_delivery',
        'estimated_delivery_date',
        'detectedAt',
        'detected_at',
        'environment',
        'region',
        'source',
      ].includes(key)
    ) {
      continue;
    }
    raw[key] = value;
  }
  return raw;
}
