import { HttpError } from '../http.js';
import { cachedRemote } from '../settle.js';
import { readTicketId } from '../ticket.js';

// A tela /pix chama esta rota a cada segundo. O id é um ticket assinado que só vale junto com a
// chave secreta do navegador de quem comprou, então um id descoberto não expõe pedido nenhum.
// O status vem do gateway (com cache curto na instância); total e datas vêm do próprio ticket.
export async function statusLive(ctx, req, { data }) {
  if (!ctx.config.stateSecretOk) throw new HttpError(503, 'Pagamento indisponível no momento.');

  const id = String(data.id || '');
  const ticket = readTicketId(ctx.config.stateSecret, id, String(data.key || ''));
  if (!ticket) throw new HttpError(404, 'Pedido não encontrado.');

  let remote;
  try {
    remote = await cachedRemote(ctx, ticket.g);
  } catch (err) {
    ctx.log('warn', 'consulta ao gateway falhou', { error: err.message });
    throw new HttpError(502, 'Não foi possível consultar o pagamento agora.');
  }
  if (!remote) throw new HttpError(404, 'Pedido não encontrado.');

  // Um PIX pendente cujo prazo passou é exibido como expirado.
  const status = remote.status === 'pending' && ticket.ea <= ctx.now() ? 'expired' : remote.status;

  // A tela substitui o estado inteiro por esta resposta: pixCode e datas precisam vir sempre.
  return {
    status: 200,
    body: { id, status, pixCode: remote.pixCode || ticket.pix || '', total: ticket.tot, createdAt: ticket.ca, expiresAt: ticket.ea },
  };
}
