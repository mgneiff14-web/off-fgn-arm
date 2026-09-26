import { randomUUID } from 'node:crypto';

// Gateway de mentira, só para desenvolvimento local. O "PIX" gerado não é pagável e o estado
// vive na memória do processo. Para simular o pagamento: POST /api/shop/dev/mock-pay { "id": "<id do pedido>" }.
export function createMockGateway() {
  const transactions = new Map();
  let statusCalls = 0;

  return {
    name: 'mock',
    configured: true,
    statusReturnsPixCode: true,
    alwaysSealContext: true, // o mock guarda o contexto como metadado (simula gateways que o devolvem)

    async createPix({ reference, amountCents, postbackUrl, metadata, expiresInMinutes }) {
      const gatewayId = `mock_${randomUUID()}`;
      const pixCode = `00020126MOCK-NAO-PAGAVEL-${gatewayId.slice(5, 13)}-${amountCents}6304MOCK`;
      transactions.set(gatewayId, {
        status: 'pending',
        pixCode,
        amountCents,
        reference,
        postbackUrl,
        metadata,
        expiresAt: Date.now() + expiresInMinutes * 60_000,
      });
      return { gatewayId, pixCode, expiresAt: transactions.get(gatewayId).expiresAt };
    },

    async getStatus(gatewayId) {
      statusCalls += 1;
      const tx = transactions.get(gatewayId);
      if (!tx) return null;
      return {
        status: tx.status,
        pixCode: tx.pixCode,
        amountCents: tx.amountCents,
        paidAt: tx.paidAt,
        feeCents: 0,
        metadata: tx.metadata,
      };
    },

    parseWebhook({ body }) {
      return { gatewayId: body?.gatewayId };
    },

    // Só para testes e para a rota de simulação.
    markPaid(gatewayId, at = Date.now()) {
      const tx = transactions.get(gatewayId);
      if (tx) Object.assign(tx, { status: 'paid', paidAt: at });
    },
    setStatus(gatewayId, status) {
      const tx = transactions.get(gatewayId);
      if (tx) tx.status = status;
    },
    inspect: (gatewayId) => transactions.get(gatewayId),
    get statusCalls() {
      return statusCalls;
    },
  };
}
