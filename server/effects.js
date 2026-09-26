// Envios de tracking de um pedido (UTMify e TikTok). Sem banco não há "marca de já enviado":
// um mesmo aviso pode chegar mais de uma vez (o gateway reenvia webhooks), e isso é inofensivo
// porque o TikTok deduplica por event_id (48 h) e a UTMify atualiza o pedido pelo orderId.

const UTMIFY_STATUS = { paid: 'paid', refunded: 'refunded', chargeback: 'chargedback', refused: 'refused' };

export function purchaseEvent(order) {
  return {
    event: 'Purchase',
    eventId: `purchase_${order.id}`,
    time: Math.floor((order.paidAt || Date.now()) / 1000),
    user: {
      email: order.customer.email,
      phone: order.customer.phone,
      ip: order.tracking?.ip,
      userAgent: order.tracking?.userAgent,
      ttclid: order.attribution?.ttclid,
      ttp: order.tracking?.ttp,
    },
    value: order.total,
    quantity: order.quantity,
    productName: order.productName,
    page: { url: order.tracking?.page },
  };
}

// Ao gerar o PIX: pedido criado como "aguardando pagamento" na UTMify. Nunca lança.
export async function sendCreatedEffects(ctx, order) {
  const result = await ctx.utmify.sendOrder(order, 'waiting_payment');
  if (!result.ok) ctx.log('warn', 'UTMify não recebeu o pedido criado', { order: order.id, error: result.error });
  return result.ok;
}

// Efeitos do status atual. Devolve { ok: false } se algum falhou (o webhook então responde
// erro e o gateway tenta de novo).
export async function runSideEffects(ctx, order) {
  const tasks = [];
  const utmifyStatus = UTMIFY_STATUS[order.status];
  if (utmifyStatus) tasks.push(ctx.utmify.sendOrder(order, utmifyStatus));
  if (order.status === 'paid') tasks.push(ctx.tiktok.send(purchaseEvent(order)));

  const results = await Promise.all(tasks);
  for (const result of results.filter((r) => !r.ok)) {
    ctx.log('warn', 'envio de tracking falhou', { order: order.id, error: result.error });
  }
  return { ok: results.every((r) => r.ok) };
}
