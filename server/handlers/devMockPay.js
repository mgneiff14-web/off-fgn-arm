import { HttpError } from '../http.js';
import { settle } from '../settle.js';
import { peekTicketId } from '../ticket.js';

// Só existe com PAYMENT_GATEWAY=mock rodando local: marca o pedido como pago e segue o mesmo
// caminho do webhook real, para testar redirecionamento, UTMify e TikTok sem cobrar ninguém.
export async function devMockPay(ctx, req, { data }) {
  if (ctx.gateway.name !== 'mock' || ctx.config.production || ctx.config.onVercel) {
    throw new HttpError(404, 'Rota não encontrada.');
  }
  const ticket = peekTicketId(String(data.id || ''));
  if (!ticket) throw new HttpError(404, 'Pedido não encontrado.');

  ctx.gateway.markPaid(ticket.g);
  ctx.cache.delete(ticket.g);
  const result = await settle(ctx, ticket.g);
  return { status: 200, body: { ok: Boolean(result.ok), status: result.status, ignored: result.ignored } };
}
