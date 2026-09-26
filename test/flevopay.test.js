import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createFlevoPay, mapStatus, parseBrasilia } from '../server/gateways/flevopay.js';
import { makeApp, validOrder } from './helpers.js';

const API_KEY = 'flevopay_chave_de_teste';
const KEY = validOrder().key;
const sha = (v) => createHash('sha256').update(v).digest('hex');
const PIX = `00020126580014br.gov.bcb.pix0136${'a1b2c3d4-'.repeat(8)}5204000053039865802BR5909FLEVOPAY6304ABCD`;

const pad = (n) => String(n).padStart(2, '0');
// Como a FlevoPay escreve datas: "YYYY-MM-DD HH:MM:SS" no horário de Brasília.
function brasilia(ms) {
  const d = new Date(ms - 3 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// Servidor FlevoPay de mentira que segue a documentação: X-API-Key obrigatória, campos
// obrigatórios da criação, resposta de sucesso da criação e consulta por external_id (sempre array).
function fakeFlevoPay() {
  const transactions = new Map();
  const requests = [];
  const state = { down: false };
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  async function fetchFn(url, init) {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url, method: init.method, headers: init.headers, body });
    if (state.down) throw new Error('rede fora do ar');
    if (init.headers['X-API-Key'] !== API_KEY) return reply(401, { success: false, message: 'Unauthorized' });

    if (u.pathname === '/api/v1/transaction' && init.method === 'POST') {
      for (const field of ['amount', 'description', 'reference']) {
        if (!body[field]) return reply(400, { success: false, message: `campo obrigatório: ${field}` });
      }
      for (const field of ['name', 'email', 'document', 'phone']) {
        if (!body.customer?.[field]) return reply(400, { success: false, message: `campo obrigatório: customer.${field}` });
      }
      if (!body.source && !body.productHash) return reply(400, { success: false, message: 'productHash obrigatório' });
      if (transactions.has(body.reference)) return reply(400, { success: false, message: 'reference já utilizada' });
      const now = Date.now();
      transactions.set(body.reference, { request: body, status: 'pending', created: brasilia(now), updated: brasilia(now) });
      return reply(200, {
        status: 'success', transaction_id: 238, id: body.reference, qr_code: PIX,
        qr_code_base64: 'data:image/png;base64,AAAA', amount: body.amount, acquirer: 'Adquirente', attempts: 1,
        expires_at: brasilia(now + 60 * 60 * 1000),
      });
    }

    if (u.pathname === '/api/v1/query' && u.searchParams.get('action') === 'list_transactions') {
      const ref = u.searchParams.get('external_id');
      const tx = transactions.get(ref);
      return reply(200, tx ? [{ id: 158, external_id: ref, status: tx.status, amount: tx.request.amount, created_at: tx.created, updated_at: tx.updated, amount_in_reais: '77,90' }] : []);
    }
    return reply(404, { success: false, message: 'Not found' });
  }

  return {
    fetchFn,
    requests,
    transactions,
    state,
    setStatus(reference, status) {
      const tx = transactions.get(reference);
      tx.status = status;
      tx.updated = brasilia(Date.now());
    },
    // Payload de webhook exatamente como na documentação.
    webhookBody(reference, status = 'approved') {
      const tx = transactions.get(reference);
      const req = tx.request;
      return {
        transaction_id: 'FLEVOPAY_9X2A1B8C', external_id: reference, store_reference: reference,
        e2e_id: 'E00416968202609131950A1B2C3D4E5F', status, raw_status: status.toUpperCase(),
        amount: req.amount, payment_method: 'pix',
        customer: { name: req.customer.name, email: req.customer.email, phone: req.customer.phone, document: req.customer.document },
        address: { street: req.address.street, number: req.address.number, complement: req.address.complement ?? null, neighborhood: req.address.neighborhood, city: req.address.city, state: req.address.state, zipcode: req.address.zipcode },
        product: { name: req.description, hash: 'prod_a1b2c3d4e5' },
        pix_code: PIX, tracking: req.tracking ?? {}, webhook_type: 'transaction', timestamp: brasilia(Date.now()),
      };
    },
  };
}

function flevoApp({ env = {}, ...rest } = {}) {
  const fake = fakeFlevoPay();
  const app = makeApp({ env: { PAYMENT_GATEWAY: 'flevopay', FLEVOPAY_API_KEY: API_KEY, ...env }, gatewayFetch: fake.fetchFn, ...rest });
  const createdRequest = () => fake.requests.find((r) => r.url.endsWith('/api/v1/transaction')).body;
  const webhookPath = () => { const u = new URL(createdRequest().postback_url); return u.pathname + u.search; };
  return { ...app, fake, createdRequest, webhookPath };
}

test('status e datas da FlevoPay são traduzidos corretamente', () => {
  assert.deepEqual(
    ['pending', 'processing', 'under_review', 'approved', 'failed', 'refunded', 'chargeback', 'qualquer'].map(mapStatus),
    ['pending', 'pending', 'pending', 'paid', 'canceled', 'refunded', 'chargeback', 'pending'],
  );
  assert.equal(parseBrasilia('2026-09-26 21:30:00'), Date.UTC(2026, 8, 27, 0, 30, 0), '21:30 em Brasília = 00:30 UTC do dia seguinte');
  assert.equal(parseBrasilia('lixo'), null);
});

test('createPix: o pedido enviado segue a documentação (campos, chave e nada a mais)', async () => {
  const { fetchFn, requests } = fakeFlevoPay();
  const gateway = createFlevoPay({ apiKey: API_KEY }, fetchFn);
  const result = await gateway.createPix({
    reference: 'ord_abc123', amountCents: 13135, description: 'Armário Multiuso de Aço — 2 Pretos x2',
    postbackUrl: 'https://loja.test/api/shop/webhook?token=t&s=XYZ',
    customer: { name: 'Maria Silva', email: 'm@x.co', phone: '44999907675', cpf: '52998224725' },
    address: { cep: '87020000', street: 'Rua das Flores', number: '100', extra: '', district: 'Centro', city: 'Maringá', state: 'PR' },
    attribution: { utm_source: 'tiktok', sck: 'abc', ttclid: 'NAO-VAI', campaign_id: '9' },
  });

  const [req] = requests;
  assert.equal(req.url, 'https://app.flevopay.com.br/api/v1/transaction');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['X-API-Key'], API_KEY);
  assert.deepEqual(req.body, {
    amount: 13135,
    description: 'Armário Multiuso de Aço - 2 Pretos x2', // o travessão original (—) vira hífen
    reference: 'ord_abc123',
    postback_url: 'https://loja.test/api/shop/webhook?token=t&s=XYZ',
    source: 'api_externa',
    customer: { name: 'Maria Silva', email: 'm@x.co', phone: '44999907675', document: '52998224725' },
    address: { street: 'Rua das Flores', number: '100', neighborhood: 'Centro', city: 'Maringá', state: 'PR', zipcode: '87020000' },
    tracking: { utm_source: 'tiktok', sck: 'abc' },
  });

  assert.equal(result.gatewayId, 'ord_abc123', 'a referência é o identificador do pedido');
  assert.equal(result.pixCode, PIX);
  assert.ok(result.expiresAt > Date.now() + 50 * 60_000 && result.expiresAt < Date.now() + 70 * 60_000, 'validade ~60 min, lida em horário de Brasília');
});

test('createPix: chave inválida, resposta sem qr_code e rede fora viram erro (sem expor a chave)', async () => {
  const fake = fakeFlevoPay();
  const args = {
    reference: 'r1', amountCents: 100, description: 'x',
    customer: { name: 'A B', email: 'a@b.co', phone: '44999907675', cpf: '52998224725' }, address: {},
  };
  await assert.rejects(createFlevoPay({ apiKey: 'errada' }, fake.fetchFn).createPix(args), (e) => /401/.test(e.message) && !e.message.includes('errada'));
  await assert.rejects(createFlevoPay({ apiKey: API_KEY }, async () => ({ ok: true, status: 200, json: async () => ({ status: 'success' }) })).createPix(args), /qr_code/);
  fake.state.down = true;
  await assert.rejects(createFlevoPay({ apiKey: API_KEY }, fake.fetchFn).createPix(args), /rede/);
});

test('createPix: validade absurda é ignorada (o servidor usa a própria)', async () => {
  const past = async () => ({ ok: true, status: 200, json: async () => ({ status: 'success', qr_code: PIX, expires_at: '2020-01-01 10:00:00' }) });
  const result = await createFlevoPay({ apiKey: API_KEY }, past).createPix({ reference: 'r', amountCents: 1, description: 'x', customer: {}, address: {} });
  assert.equal(result.expiresAt, undefined);
});

test('getStatus: consulta por external_id, traduz o status e devolve valor e datas', async () => {
  const fake = fakeFlevoPay();
  const gateway = createFlevoPay({ apiKey: API_KEY }, fake.fetchFn);
  const args = {
    reference: 'ord_ref/1', amountCents: 7790, description: 'x', postbackUrl: '',
    customer: { name: 'A B', email: 'a@b.co', phone: '44999907675', cpf: '52998224725' }, address: {},
  };
  await gateway.createPix(args);

  const pending = await gateway.getStatus('ord_ref/1');
  const query = fake.requests.at(-1);
  assert.equal(query.method, 'GET');
  assert.ok(query.url.endsWith('/api/v1/query?action=list_transactions&external_id=ord_ref%2F1'), query.url);
  assert.equal(query.headers['X-API-Key'], API_KEY);
  assert.deepEqual([pending.status, pending.amountCents], ['pending', 7790]);
  assert.equal(pending.paidAt, undefined);

  fake.setStatus('ord_ref/1', 'approved');
  const paid = await gateway.getStatus('ord_ref/1');
  assert.equal(paid.status, 'paid');
  assert.ok(Math.abs(paid.paidAt - Date.now()) < 5000, 'paidAt lido de updated_at (Brasília)');

  assert.equal(await gateway.getStatus('nao-existe'), null);
  await assert.rejects(createFlevoPay({ apiKey: 'errada' }, fake.fetchFn).getStatus('x'), /401/);
});

test('parseWebhook: pega a referência e ignora avisos que não são de transação', () => {
  const gateway = createFlevoPay({ apiKey: API_KEY });
  assert.deepEqual(gateway.parseWebhook({ body: { webhook_type: 'outro', external_id: 'x' } }), {});
  assert.deepEqual(gateway.parseWebhook({ body: {} }), {});
  assert.equal(gateway.parseWebhook({ body: { store_reference: 'ord_1' } }).gatewayId, 'ord_1');

  const snap = gateway.parseWebhook({
    body: {
      external_id: 'ord_2', amount: 15580, webhook_type: 'transaction',
      customer: { name: 'Maria Silva', email: 'm@x.co', phone: '(44) 99990-7675', document: '529.982.247-25' },
      address: { street: 'Rua A', number: '1', complement: null, neighborhood: 'Centro', city: 'Maringá', state: 'PR', zipcode: '87020-000' },
      product: { name: 'Armário Multiuso x2', hash: 'h1' }, tracking: { utm_source: 'tiktok', utm_term: null },
    },
  }).snapshot;
  assert.equal(snap.total, 15580);
  assert.equal(snap.quantity, 2);
  assert.equal(snap.customer.cpf, '52998224725');
  assert.equal(snap.customer.phone, '44999907675');
  assert.equal(snap.address.cep, '87020000');
  assert.deepEqual(snap.attribution, { utm_source: 'tiktok' });
});

test('fluxo completo: criar, consultar (código PIX vem no id), pagar, webhook, tracking', async () => {
  const app = flevoApp();
  const order = await app.createOrder();
  const ref = order.gatewayId;

  assert.ok(ref.startsWith('ord_'));
  assert.ok(order.id.length < 1000, `id com o código PIX embutido continua razoável (${order.id.length})`);
  const sent = app.createdRequest();
  assert.equal(sent.reference, ref);
  assert.equal(sent.amount, 7790);
  assert.equal(sent.tracking.utm_source, 'tiktok');
  assert.equal(sent.address.zipcode, '87020000');
  assert.ok(new URL(sent.postback_url).searchParams.get('s'), 'contexto criptografado na URL do webhook');
  assert.equal(order.pixCode, PIX);

  // A consulta da FlevoPay (list_transactions) não traz o código: ele tem que vir do id do pedido.
  const status = await app.call('POST', '/api/shop/status/live', { body: { id: order.id, key: KEY } });
  assert.equal(status.json.status, 'pending');
  assert.equal(status.json.pixCode, PIX);
  assert.equal(status.json.total, 7790);

  app.fake.setStatus(ref, 'approved');
  const hook = await app.call('POST', app.webhookPath(), { body: app.fake.webhookBody(ref) });
  assert.equal(hook.status, 200);

  assert.equal((await app.call('POST', '/api/shop/status/live', { body: { id: order.id, key: KEY } })).json.status, 'paid');
  const [purchase] = app.calls.tiktok.filter((c) => c.body.data[0].event === 'Purchase');
  const evt = purchase.body.data[0];
  assert.equal(evt.event_id, `purchase_${ref}`);
  assert.equal(evt.user.email, sha('maria@example.com'));
  assert.equal(evt.user.ttclid, 'CLICK123', 'dados do navegador chegaram pelo contexto da URL');
  assert.equal(evt.user.ip, '203.0.113.7');
  assert.equal(app.calls.utmify.filter((c) => c.body.status === 'paid').length, 1);
  assert.equal(app.calls.utmify.find((c) => c.body.status === 'paid').body.orderId, ref);
});

test('webhook sem o contexto na URL (ex.: truncada): usa os dados do próprio aviso', async () => {
  const app = flevoApp();
  const order = await app.createOrder();
  const ref = order.gatewayId;
  app.fake.setStatus(ref, 'approved');

  const truncated = app.webhookPath().replace(/([?&])s=[^&]*/, '$1s=cortada'); // a FlevoPay guardou só um pedaço
  assert.ok(truncated.includes('s=cortada'), 'a URL foi realmente cortada');
  const hook = await app.call('POST', truncated, { body: app.fake.webhookBody(ref) });
  assert.equal(hook.status, 200);

  const evt = app.calls.tiktok.find((c) => c.body.data[0].event === 'Purchase').body.data[0];
  assert.equal(evt.user.email, sha('maria@example.com'), 'e-mail veio do webhook');
  assert.equal(evt.user.ttclid, undefined, 'sem contexto do navegador não há ttclid');
  assert.equal(evt.properties.value, 77.9);
  const paid = app.calls.utmify.find((c) => c.body.status === 'paid').body;
  assert.equal(paid.trackingParameters.utm_source, 'tiktok', 'UTMs vieram do webhook');
  assert.equal(paid.customer.document, '52998224725');
});

test('padrão (WEBHOOK_CONTEXT desligado): requisição enxuta como a de uma integração normal', async () => {
  const app = flevoApp({ env: { WEBHOOK_CONTEXT: '' } });
  const order = await app.createOrder({ kit: { id: 'armario-multiuso-2-pretos', quantity: 1, shipping: 'standard', coupon: '' } });
  const sent = app.createdRequest();
  assert.equal(sent.postback_url, 'https://loja.test/api/shop/webhook', 'URL curta: sem ?s= e sem token');
  assert.equal(sent.description, 'Armário Multiuso de Aço - 2 Pretos x1', 'travessão trocado por hífen, acentos mantidos');
  const request = app.fake.requests.find((r) => r.url.endsWith('/api/v1/transaction'));
  assert.deepEqual(Object.keys(request.headers).sort(), ['Content-Type', 'X-API-Key'], 'sem Accept');

  app.fake.setStatus(order.gatewayId, 'approved');
  const hook = await app.call('POST', app.webhookPath(), { body: app.fake.webhookBody(order.gatewayId) });
  assert.equal(hook.status, 200);

  // Purchase com os dados do aviso (sem ttclid/IP, que só viajam com WEBHOOK_CONTEXT=on).
  const evt = app.calls.tiktok.find((c) => c.body.data[0].event === 'Purchase').body.data[0];
  assert.equal(evt.user.email, sha('maria@example.com'));
  assert.equal(evt.user.ttclid, undefined);

  // O createdAt da UTMify é o mesmo na criação e no pagamento, lido da própria referência.
  const waiting = app.calls.utmify.find((c) => c.body.status === 'waiting_payment').body;
  const paid = app.calls.utmify.find((c) => c.body.status === 'paid').body;
  assert.equal(paid.createdAt, waiting.createdAt);
  assert.equal(paid.orderId, waiting.orderId);
});

test('o endereço do webhook vem do host da requisição quando PUBLIC_BASE_URL não está definida', async () => {
  const app = flevoApp({ env: { PUBLIC_BASE_URL: '', WEBHOOK_CONTEXT: '' } });
  const res = await app.call('POST', '/api/shop/create', {
    body: validOrder(),
    headers: { 'x-forwarded-host': 'minha-loja.vercel.app', 'x-forwarded-proto': 'https' },
  });
  assert.equal(res.status, 200);
  assert.equal(app.createdRequest().postback_url, 'https://minha-loja.vercel.app/api/shop/webhook');

  const weird = flevoApp({ env: { PUBLIC_BASE_URL: '', WEBHOOK_CONTEXT: '' } });
  await weird.call('POST', '/api/shop/create', { body: validOrder(), headers: { 'x-forwarded-host': 'evil.com/../x' } });
  assert.ok(!('postback_url' in weird.createdRequest()), 'host malformado é ignorado');
});

test('WEBHOOK_CONTEXT=on: a URL do webhook leva o contexto criptografado', async () => {
  const app = flevoApp({ env: { WEBHOOK_CONTEXT: 'on' } });
  await app.createOrder();
  assert.ok(new URL(app.createdRequest().postback_url).searchParams.get('s'));
});

test('TIKTOK_EVENT_NAME troca o nome do evento de compra', async () => {
  const app = flevoApp({ env: { TIKTOK_EVENT_NAME: 'CompletePayment' } });
  const order = await app.createOrder();
  app.fake.setStatus(order.gatewayId, 'approved');
  await app.call('POST', app.webhookPath(), { body: app.fake.webhookBody(order.gatewayId) });
  assert.ok(app.calls.tiktok.some((c) => c.body.data[0].event === 'CompletePayment'));
  assert.ok(!app.calls.tiktok.some((c) => c.body.data[0].event === 'Purchase'));
});

test('webhook falso: "approved" no corpo com o gateway ainda pendente não envia nada', async () => {
  const app = flevoApp();
  const order = await app.createOrder();
  const forged = app.fake.webhookBody(order.gatewayId, 'approved'); // a FlevoPay diz pending
  const hook = await app.call('POST', app.webhookPath(), { body: forged });
  assert.equal(hook.status, 200);
  assert.equal(app.calls.tiktok.length, 0);
  assert.equal(app.calls.utmify.filter((c) => c.body.status === 'paid').length, 0);
});

test('webhook: valor diferente do pedido é ignorado', async () => {
  const app = flevoApp();
  const order = await app.createOrder();
  app.fake.transactions.get(order.gatewayId).request.amount = 100;
  app.fake.setStatus(order.gatewayId, 'approved');
  const hook = await app.call('POST', app.webhookPath(), { body: app.fake.webhookBody(order.gatewayId) });
  assert.equal(hook.json.ignored, 'valor-diferente');
  assert.equal(app.calls.tiktok.length, 0);
});

test('webhook de transação recusada/expirada: pedido cancelado, sem tracking de venda', async () => {
  const app = flevoApp();
  const order = await app.createOrder();
  app.fake.setStatus(order.gatewayId, 'failed');
  const hook = await app.call('POST', app.webhookPath(), { body: app.fake.webhookBody(order.gatewayId, 'failed') });
  assert.equal(hook.status, 200);
  assert.equal(app.calls.tiktok.length, 0);
  assert.equal((await app.call('POST', '/api/shop/status/live', { body: { id: order.id, key: KEY } })).json.status, 'canceled');
});

test('FlevoPay fora do ar: criar dá erro amigável, consultar dá 502 e o webhook pede nova tentativa', async () => {
  const app = flevoApp();
  const order = await app.createOrder();
  app.fake.state.down = true;
  app.advance(4000); // vence o cache do status

  const create = await app.call('POST', '/api/shop/create', { body: validOrder({ key: 'outra-chave-valida-0001-xxxx' }) });
  assert.deepEqual([create.status, create.json.error], [502, 'Não foi possível gerar o Pix. Tente novamente.']);
  assert.equal((await app.call('POST', '/api/shop/status/live', { body: { id: order.id, key: KEY } })).status, 502);
  assert.equal((await app.call('POST', app.webhookPath(), { body: { external_id: order.gatewayId, webhook_type: 'transaction' } })).status, 500);
});

test('sem FLEVOPAY_API_KEY o pagamento fica indisponível', async () => {
  const app = flevoApp({ env: { FLEVOPAY_API_KEY: '' } });
  assert.equal((await app.call('GET', '/api/shop/catalog')).json.paymentConfigured, false);
  assert.equal((await app.call('POST', '/api/shop/create', { body: validOrder() })).status, 503);
});
