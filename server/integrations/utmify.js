// UTMify: API de pedidos. Um pedido é enviado como `waiting_payment` ao gerar o PIX e
// reenviado com o mesmo orderId/createdAt quando muda de status (paid, refunded, ...).
const ENDPOINT = 'https://api.utmify.com.br/api-credentials/orders';

const TRACKING_KEYS = ['src', 'sck', 'utm_source', 'utm_campaign', 'utm_medium', 'utm_content', 'utm_term'];
const pad = (n) => String(n).padStart(2, '0');

// A UTMify exige "YYYY-MM-DD HH:MM:SS" em UTC.
export function utcStamp(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function buildOrderPayload(order, status, { platform, isTest }) {
  const fee = order.gateway?.feeCents || 0;
  const refunded = status === 'refunded' || status === 'chargedback';
  return {
    orderId: order.id,
    platform,
    paymentMethod: 'pix',
    status,
    createdAt: utcStamp(order.createdAt),
    approvedDate: status === 'paid' && order.paidAt ? utcStamp(order.paidAt) : null,
    refundedAt: refunded ? utcStamp(order.refundedAt || Date.now()) : null,
    customer: {
      name: order.customer.name,
      email: order.customer.email,
      phone: order.customer.phone,
      document: order.customer.cpf,
      country: 'BR',
      ...(order.tracking?.ip ? { ip: order.tracking.ip } : {}),
    },
    products: [
      {
        id: order.productId,
        name: order.productName,
        planId: null,
        planName: null,
        quantity: order.quantity,
        // Preço efetivo por unidade (já com cupom e frete), para a soma bater com o total.
        priceInCents: Math.round(order.total / order.quantity),
      },
    ],
    trackingParameters: Object.fromEntries(TRACKING_KEYS.map((k) => [k, order.attribution?.[k] || null])),
    commission: {
      totalPriceInCents: order.total,
      gatewayFeeInCents: fee,
      userCommissionInCents: order.total - fee,
    },
    isTest: Boolean(isTest),
  };
}

export function createUtmify({ token, platform, isTest }, fetchFn = fetch) {
  const enabled = Boolean(token);

  async function sendOrder(order, status) {
    if (!enabled) return { ok: true, skipped: true };
    try {
      const res = await fetchFn(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-token': token },
        body: JSON.stringify(buildOrderPayload(order, status, { platform, isTest })),
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) return { ok: true };
      return { ok: false, error: `utmify http=${res.status}` };
    } catch (err) {
      return { ok: false, error: `utmify ${err.name}` };
    }
  }

  return { enabled, sendOrder };
}
