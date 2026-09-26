import { HttpError, parseCookies } from '../http.js';
import { defaultProduct, findProduct } from '../pricing.js';
import { cleanAttribution } from '../validators.js';

const KINDS = new Set(['ViewContent', 'AddToCart', 'InitiateCheckout']);
const EVENT_ID_RE = /^[A-Za-z0-9_:.-]{6,120}$/;
const SEVEN_DAYS = 7 * 24 * 3600 * 1000;

// O front envia o horário original do evento (createdAt). Aceita se estiver na janela que o
// TikTok aceita; senão usa o horário do servidor.
function eventTime(createdAt, now) {
  const t = Number(createdAt);
  return Number.isFinite(t) && t > now - SEVEN_DAYS && t <= now + 60_000
    ? Math.floor(t / 1000)
    : Math.floor(now / 1000);
}

// Recebe os eventos do navegador e os repassa ao TikTok Events API com o mesmo event_id do pixel.
// Responde { accepted, value }; para InitiateCheckout o front reenvia enquanto accepted for false.
// Reenvios não geram duplicidade: o TikTok deduplica por (evento + event_id) em até 48 h.
export async function event(ctx, req, { data, ip }) {
  const kind = String(data.kind || '');
  const id = String(data.id || '');
  if (!KINDS.has(kind)) throw new HttpError(400, 'Evento inválido.');
  if (!EVENT_ID_RE.test(id)) throw new HttpError(400, 'Identificador de evento inválido.');

  const product = findProduct(data.productId) || defaultProduct();
  const value = product.price;
  const attribution = cleanAttribution(data.attribution);

  const result = await ctx.tiktok.send({
    event: kind,
    eventId: id,
    time: eventTime(data.createdAt, ctx.now()),
    user: {
      ip,
      userAgent: req.headers['user-agent'],
      ttclid: attribution.ttclid,
      ttp: parseCookies(req.headers.cookie)._ttp,
    },
    value,
    productName: product.name,
    page: { url: req.headers.referer },
  });
  if (!result.ok) ctx.log('warn', 'evento não aceito pelo TikTok', { kind, error: result.error });

  return { status: 200, body: { accepted: result.ok, value } };
}
