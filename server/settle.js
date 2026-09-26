import { runSideEffects } from './effects.js';
import { open } from './seal.js';

const cacheTtl = (status) => (status === 'pending' ? 3000 : 60_000);

// Consulta o gateway (sempre a versão mais recente, ignorando o cache), guarda o resultado no
// cache para as próximas consultas da tela do PIX e devolve o que o gateway diz.
export async function fetchRemote(ctx, gatewayId) {
  const remote = await ctx.gateway.getStatus(gatewayId);
  if (remote) ctx.cache.set(gatewayId, remote, cacheTtl(remote.status));
  return remote;
}

// Versão com cache, usada pela tela do PIX (que pergunta a cada segundo).
export async function cachedRemote(ctx, gatewayId) {
  const hit = ctx.cache.get(gatewayId);
  if (hit) return hit;
  return fetchRemote(ctx, gatewayId);
}

// Confirma o status no gateway e dispara UTMify/TikTok conforme o status. Usado pelo webhook.
// O contexto do pedido vem, em ordem de preferência, de: (1) URL do webhook (`sealed`),
// (2) metadados que o gateway devolve, (3) `snapshot`, os dados que o próprio aviso traz
// (sem IP, user-agent, _ttp e ttclid: o Purchase sai com menos dados de correspondência).
export async function settle(ctx, gatewayId, { sealed = '', snapshot = null } = {}) {
  const remote = await fetchRemote(ctx, gatewayId);
  if (!remote) return { ignored: 'desconhecido' };

  let context = open(ctx.config.stateSecret, sealed) || open(ctx.config.stateSecret, remote.metadata);
  if (!context && snapshot) {
    ctx.log('warn', 'sem contexto do navegador: usando os dados do próprio webhook', { gateway: gatewayId });
    context = { ...snapshot, createdAt: remote.createdAt || ctx.now() };
  }
  if (!context) {
    ctx.log('warn', 'webhook sem contexto do pedido (segredo diferente ou dados não devolvidos)', { gateway: gatewayId });
    return { ignored: 'sem-contexto', status: remote.status };
  }

  // Nunca confia só no aviso: o valor confirmado pelo gateway precisa bater com o pedido.
  if (Number.isFinite(remote.amountCents) && remote.amountCents !== context.total) {
    ctx.log('warn', 'valor pago difere do pedido', { gateway: gatewayId });
    return { ignored: 'valor-diferente', status: remote.status };
  }

  const order = {
    ...context,
    id: gatewayId,
    status: remote.status,
    paidAt: remote.paidAt || ctx.now(),
    refundedAt: ctx.now(),
    gateway: { name: ctx.gateway.name, feeCents: remote.feeCents || 0 },
  };
  const effects = await runSideEffects(ctx, order);
  return { ok: effects.ok, status: remote.status };
}
