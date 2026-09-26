import { HttpError, safeEqual } from '../http.js';
import { settle } from '../settle.js';

// Recebe o aviso do gateway. Responde 200 para tudo que não precisa de nova tentativa
// (inclusive pedidos desconhecidos) e erro só quando vale o gateway reenviar.
export async function webhook(ctx, req, { data, raw, query }) {
  if (ctx.config.webhookToken && !safeEqual(query.token || '', ctx.config.webhookToken)) {
    throw new HttpError(401, 'Não autorizado.');
  }

  // Cada gateway valida a própria assinatura aqui e lança HttpError(401) se não bater.
  const event = await ctx.gateway.parseWebhook({ headers: req.headers, body: data, raw, query });
  if (!event?.gatewayId) return { status: 200, body: { ok: true, ignored: 'sem-id' } };

  const result = await settle(ctx, String(event.gatewayId), { sealed: query.s || '', snapshot: event.snapshot });
  if (result.ignored) return { status: 200, body: { ok: true, ignored: result.ignored } };
  if (!result.ok) throw new HttpError(500, 'Falha temporária ao registrar o pedido.');
  return { status: 200, body: { ok: true } };
}
