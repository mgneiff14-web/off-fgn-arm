import { onlyDigits } from '../validators.js';

// FlevoPay (PIX). Documentação: POST /api/v1/transaction, GET /api/v1/query, webhooks por transação.
//
// Decisões que decorrem da documentação:
//  - O identificador do pedido no gateway é a nossa `reference` (única por tentativa). Ela volta como
//    `id` na criação e como `external_id`/`store_reference` no webhook, e é a chave da consulta
//    `list_transactions&external_id=`. Assim não dependemos dos ids internos (numérico/ofuscado),
//    que a documentação descreve de formas diferentes.
//  - A API não documenta assinatura de webhook. A autenticidade vem de WEBHOOK_TOKEN na URL do
//    webhook + confirmação do status pela API (feita em settle.js). O corpo do aviso nunca basta.
//  - A consulta de status não documenta devolver o código copia-e-cola: statusReturnsPixCode=false
//    faz o servidor levá-lo dentro do id do pedido.
//  - Não há parâmetro de validade: usamos o `expires_at` da resposta (horário de Brasília).

const DEFAULT_BASE_URL = 'https://app.flevopay.com.br';
const TIMEOUT_MS = 8000;
const TRACKING_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'src', 'sck'];
const DAY_MS = 24 * 3600 * 1000;

const STATUS = {
  pending: 'pending',
  processing: 'pending', // adquirente processando
  under_review: 'pending', // análise manual de segurança: ainda não é pagamento confirmado
  approved: 'paid',
  failed: 'canceled', // recusado, cancelado ou expirado
  refunded: 'refunded',
  chargeback: 'chargeback',
};

export const mapStatus = (status) => STATUS[String(status || '').toLowerCase()] || 'pending';

// "2026-09-13 19:50:22" em horário de Brasília (UTC-3, sem horário de verão desde 2019).
export function parseBrasilia(text) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(String(text || ''));
  if (!m) return null;
  const time = Date.parse(`${m[1]}T${m[2]}-03:00`);
  return Number.isFinite(time) ? time : null;
}

const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));

// Procura, em qualquer parte da resposta, uma string com cara de PIX copia-e-cola (EMV: "000201...").
function findPixCode(value, depth = 0) {
  if (typeof value === 'string') return /^000201/.test(value) && value.length >= 80 && value.length <= 1000 ? value : '';
  if (!value || typeof value !== 'object' || depth > 4) return '';
  for (const item of Object.values(value)) {
    const found = findPixCode(item, depth + 1);
    if (found) return found;
  }
  return '';
}

// Dados que o próprio webhook traz: usados só se o contexto criptografado não chegar (por
// exemplo, se a FlevoPay truncar a URL do webhook). Não têm IP, user-agent, _ttp nem ttclid.
function snapshotFromWebhook(body) {
  const customer = body.customer || {};
  const address = body.address || {};
  const rawName = String(body.product?.name || 'Armário Multiuso').slice(0, 200);
  const qty = /\s+x(\d{1,2})$/.exec(rawName);
  return {
    productId: String(body.product?.hash || 'armario-multiuso'),
    productName: rawName,
    quantity: qty ? Number(qty[1]) : 1,
    total: Number(body.amount),
    customer: {
      name: String(customer.name || ''),
      email: String(customer.email || ''),
      phone: onlyDigits(customer.phone),
      cpf: onlyDigits(customer.document),
    },
    address: {
      cep: onlyDigits(address.zipcode),
      street: address.street || '',
      number: address.number || '',
      extra: address.complement || '',
      district: address.neighborhood || '',
      city: address.city || '',
      state: address.state || '',
    },
    attribution: compact(Object.fromEntries(TRACKING_KEYS.map((k) => [k, body.tracking?.[k]]))),
    tracking: { ip: '', userAgent: '', ttp: '', page: '' },
  };
}

export function createFlevoPay({ apiKey, baseUrl = DEFAULT_BASE_URL } = {}, fetchFn = fetch) {
  async function request(path, { method = 'GET', body } = {}) {
    const res = await fetchFn(`${baseUrl}${path}`, {
      method,
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json().catch(() => null);
    return { res, json };
  }

  return {
    name: 'flevopay',
    configured: Boolean(apiKey),
    statusReturnsPixCode: false,

    async createPix({ reference, amountCents, customer, address, description, postbackUrl, attribution = {} }) {
      const tracking = compact(Object.fromEntries(TRACKING_KEYS.map((k) => [k, attribution[k]])));
      const startedAt = Date.now();
      const { res, json } = await request('/api/v1/transaction', {
        method: 'POST',
        body: {
          amount: amountCents,
          description,
          reference,
          ...(postbackUrl ? { postback_url: postbackUrl } : {}),
          source: 'api_externa', // produtos não são cadastrados na plataforma: dispensa productHash
          customer: { name: customer.name, email: customer.email, phone: customer.phone, document: customer.cpf },
          address: compact({
            street: address.street,
            number: address.number,
            complement: address.extra,
            neighborhood: address.district,
            city: address.city,
            state: address.state,
            zipcode: address.cep,
          }),
          ...(Object.keys(tracking).length ? { tracking } : {}),
        },
      });

      if (!res.ok || json?.status !== 'success' || !json.qr_code) {
        throw new Error(`FlevoPay ${res.status}: ${json?.message || json?.error || 'resposta sem qr_code'}`);
      }

      // Só aceita a validade se for plausível (no futuro e dentro de 7 dias); senão o servidor usa a própria.
      const expires = parseBrasilia(json.expires_at);
      const now = Date.now();
      return {
        gatewayId: reference,
        pixCode: json.qr_code,
        expiresAt: expires && expires > now && expires < now + 7 * DAY_MS ? expires : undefined,
        // Só para o log do servidor (sem dados pessoais): mostra se a FlevoPay demorou ou refez tentativas.
        meta: { ms: now - startedAt, transactionId: json.transaction_id, attempts: json.attempts, acquirer: json.acquirer },
      };
    },

    async getStatus(reference) {
      const { res, json } = await request(
        `/api/v1/query?action=list_transactions&external_id=${encodeURIComponent(reference)}`,
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`FlevoPay ${res.status}`);

      const list = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
      if (!list.length) return null;
      const tx = list.find((t) => mapStatus(t.status) !== 'pending') || list[0];
      const status = mapStatus(tx.status);
      const amount = Number(tx.amount);

      return {
        status,
        amountCents: Number.isFinite(amount) ? amount : undefined,
        pixCode: findPixCode(tx) || undefined,
        paidAt: status === 'paid' ? (parseBrasilia(tx.updated_at) ?? undefined) : undefined,
        createdAt: parseBrasilia(tx.created_at) ?? undefined,
      };
    },

    parseWebhook({ body }) {
      if (!body || typeof body !== 'object') return {};
      if (body.webhook_type && body.webhook_type !== 'transaction') return {};
      const gatewayId = String(body.external_id || body.store_reference || '');
      if (!gatewayId) return {};
      return { gatewayId, snapshot: snapshotFromWebhook(body) };
    },
  };
}
