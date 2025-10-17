import { Actor, log } from 'apify';
import got from 'got';

await Actor.init();

const input = await Actor.getInput();
const sources = input?.sources ?? [];
if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('Provide sources array with { url, orderId } entries.');
}

const incidents = [];
for (const source of sources) {
    const { url, orderId, carrier = 'unknown', region = 'unknown' } = source;
    if (!url || !orderId) continue;

    try {
        const response = await got(url, { timeout: { request: 5000 } });
        const html = response.body ?? '';
        const delayed = /delay|disruption|service alert|outage/i.test(html);
        if (delayed) {
            incidents.push({
                orderId,
                carrier,
                region,
                delayHours: input.delayHours ?? 48,
                promisedDeliveryDate: input.promisedDeliveryDate,
                detectedAt: new Date().toISOString(),
                metadata: {
                    url,
                    snippet: html.slice(0, 400),
                },
            });
        }
    } catch (error) {
        log.warning(`Failed to fetch ${url}: ${error.message}`);
    }
}

await Actor.pushData(incidents);
await Actor.exit();
