import { createHash } from 'node:crypto';
import { CONTENT_ID } from '../config.js';

// TikTok Events API (web). Os eventos do servidor usam o mesmo event_id que o pixel do
// navegador, então o TikTok deduplica por (evento + event_id) em até 48 h.
const ENDPOINT = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// E-mail e telefone precisam ir em SHA-256 (minúsculo/sem espaços; telefone em E.164).
export function hashEmail(email) {
  const v = String(email || '').trim().toLowerCase();
  return v ? sha256(v) : undefined;
}

export function hashPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return undefined;
  const e164 = digits.startsWith('55') && digits.length >= 12 ? `+${digits}` : `+55${digits}`;
  return sha256(e164);
}

const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== ''));

export function createTikTok({ pixelId, accessToken, testEventCode }, fetchFn = fetch) {
  const enabled = Boolean(pixelId && accessToken);

  function buildBody({ event, eventId, time, user = {}, value, quantity = 1, productName, page = {} }) {
    const price = value / 100;
    return {
      event_source: 'web',
      event_source_id: pixelId,
      ...(testEventCode ? { test_event_code: testEventCode } : {}),
      data: [
        {
          event,
          event_time: time,
          event_id: eventId,
          user: clean({
            email: hashEmail(user.email),
            phone: hashPhone(user.phone),
            ip: user.ip,
            user_agent: user.userAgent,
            ttclid: user.ttclid,
            ttp: user.ttp,
          }),
          properties: {
            currency: 'BRL',
            value: price,
            content_type: 'product',
            contents: [
              clean({
                content_id: CONTENT_ID,
                content_type: 'product',
                content_name: productName,
                quantity,
                price: quantity > 1 ? Math.round((value / quantity)) / 100 : price,
              }),
            ],
          },
          page: clean({ url: page.url, referrer: page.referrer }),
        },
      ],
    };
  }

  // Nunca lança: devolve { ok } para quem chamou decidir se tenta de novo.
  async function send(evt) {
    if (!enabled) return { ok: true, skipped: true };
    try {
      const res = await fetchFn(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Access-Token': accessToken },
        body: JSON.stringify(buildBody(evt)),
        signal: AbortSignal.timeout(4000),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.code === 0) return { ok: true };
      return { ok: false, error: `tiktok http=${res.status} code=${json.code} ${json.message || ''}`.trim() };
    } catch (err) {
      return { ok: false, error: `tiktok ${err.name}` };
    }
  }

  return { enabled, buildBody, send };
}
