import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { seal } from '../server/seal.js';
import { SECRET, makeApp, validOrder } from './helpers.js';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const KEY = validOrder().key;
const purchases = (app) => app.calls.tiktok.filter((c) => c.body.data[0].event === 'Purchase');
const utmify = (app, status) => app.calls.utmify.filter((c) => c.body.status === status);

test('catálogo: 3 kits, pixel do TikTok e pagamento disponível', async () => {
  const { call } = makeApp();
  const res = await call('GET', '/api/shop/catalog');
  assert.equal(res.status, 200);
  assert.equal(res.json.products.length, 3);
  assert.equal(res.json.products[0].price, 7790);
  assert.equal(res.json.products.every((p) => p.payable), true);
  assert.equal(res.json.paymentConfigured, true);
  assert.equal(res.json.pixelId, 'PIXEL123');
});

test('sem gateway pronto (FlevoPay ainda não integrada) ou sem STATE_SECRET válido: pagamento indisponível', async () => {
  for (const env of [{ PAYMENT_GATEWAY: 'flevopay' }, { STATE_SECRET: 'curto' }]) {
    const app = makeApp({ env });
    assert.equal((await app.call('GET', '/api/shop/catalog')).json.paymentConfigured, false);
    assert.equal((await app.call('POST', '/api/shop/create', { body: validOrder() })).status, 503);
  }
});

test('create: gera o PIX com tudo que a tela /pix precisa e avisa a UTMify', async () => {
  const app = makeApp();
  const before = Date.now();
  const order = await app.createOrder();

  assert.equal(order.status, 'pending');
  assert.equal(order.total, 7790);
  assert.ok(order.pixCode.length > 20);
  assert.ok(order.createdAt >= before);
  assert.ok(order.expiresAt > order.createdAt);
  assert.ok(order.id.length < 130, `id curto o bastante para usar em ids de evento (${order.id.length})`);
  assert.equal(order.key, undefined);

  assert.equal(app.calls.utmify.length, 1);
  const sent = app.calls.utmify[0];
  assert.equal(sent.headers['x-api-token'], 'utmify-token');
  assert.equal(sent.body.status, 'waiting_payment');
  assert.equal(sent.body.orderId, order.gatewayId, 'a UTMify usa o id do gateway, estável entre criação e webhook');
  assert.equal(sent.body.trackingParameters.utm_source, 'tiktok');
  assert.equal(app.calls.tiktok.length, 0, 'Purchase só é enviado quando o PIX é pago');
});

test('create: o gateway recebe valor recalculado, webhook com contexto criptografado e metadados', async () => {
  const app = makeApp({ env: { WEBHOOK_TOKEN: 'token-do-webhook' } });
  const order = await app.createOrder({
    kit: { id: 'armario-multiuso-misto', quantity: 2, shipping: 'express', coupon: 'VOLTA25' },
    total: 1, // campo inventado: deve ser ignorado
  });
  assert.equal(order.total, 15580 - 3895 + 1450);

  const tx = app.ctx.gateway.inspect(order.gatewayId);
  assert.equal(tx.amountCents, order.total);
  assert.match(tx.reference, /^ord_/);
  const url = new URL(tx.postbackUrl);
  assert.equal(url.origin, 'https://loja.test');
  assert.equal(url.pathname, '/api/shop/webhook');
  assert.equal(url.searchParams.get('token'), 'token-do-webhook');
  assert.equal(url.searchParams.get('s'), tx.metadata);
  assert.ok(!tx.postbackUrl.includes('maria') && !tx.postbackUrl.includes('52998224725'), 'nada legível na URL');
  assert.ok(tx.postbackUrl.length < 2000, `URL do webhook curta (${tx.postbackUrl.length})`);
});

test('create: validações com as mesmas mensagens do formulário', async () => {
  const { call } = makeApp();
  const cases = [
    [{ customer: { name: 'Maria', email: 'a@b.co', phone: '44999907675', cpf: '52998224725' } }, /nome completo/],
    [{ customer: { name: 'Maria Silva', email: 'a@b.co', phone: '123', cpf: '52998224725' } }, /telefone/],
    [{ customer: { name: 'Maria Silva', email: 'invalido', phone: '44999907675', cpf: '52998224725' } }, /e-mail/],
    [{ customer: { name: 'Maria Silva', email: 'a@b.co', phone: '44999907675', cpf: '11111111111' } }, /CPF/],
    [{ address: { cep: '123', street: 'R', number: '1', district: 'C', city: 'M', state: 'PR' } }, /CEP/],
    [{ kit: { id: 'nao-existe', quantity: 1 } }, /Produto/],
    [{ key: 'curta' }, /inválida/],
  ];
  for (const [override, message] of cases) {
    const res = await call('POST', '/api/shop/create', { body: validOrder(override) });
    assert.equal(res.status, 400);
    assert.match(res.json.error, message);
  }
});

test('gateway falhou ao gerar o PIX: erro amigável, sem vazar detalhe', async () => {
  const app = makeApp();
  app.ctx.gateway.createPix = async () => { throw new Error('chave secreta inválida: sk_live_123'); };
  const res = await app.call('POST', '/api/shop/create', { body: validOrder() });
  assert.equal(res.status, 502);
  assert.equal(res.json.error, 'Não foi possível gerar o Pix. Tente novamente.');
  assert.equal(app.calls.utmify.length, 0);
});

test('status/live: exige o ticket certo com a chave certa; devolve pixCode e datas', async () => {
  const app = makeApp();
  const order = await app.createOrder();

  assert.equal((await app.call('POST', '/api/shop/status/live', { body: { id: order.id, key: 'outra-chave-qualquer-123' } })).status, 404);
  assert.equal((await app.call('POST', '/api/shop/status/live', { body: { id: 'nao-e-um-ticket', key: KEY } })).status, 404);
  const parts = order.id.split('.');
  parts[3] = (1).toString(36);
  assert.equal((await app.call('POST', '/api/shop/status/live', { body: { id: parts.join('.'), key: KEY } })).status, 404, 'total adulterado');

  const ok = await app.call('POST', '/api/shop/status/live', { body: { id: order.id, key: KEY } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.id, order.id);
  assert.equal(ok.json.status, 'pending');
  assert.equal(ok.json.pixCode, order.pixCode);
  assert.equal(ok.json.total, 7790);
  assert.equal(ok.json.createdAt, order.createdAt);
  assert.equal(ok.json.expiresAt, order.expiresAt);
});

test('status/live: consultas seguidas usam cache e não martelam o gateway', async () => {
  const app = makeApp();
  const order = await app.createOrder();
  const poll = () => app.call('POST', '/api/shop/status/live', { body: { id: order.id, key: KEY } });
  const base = app.ctx.gateway.statusCalls;
  await poll(); await poll(); await poll();
  assert.equal(app.ctx.gateway.statusCalls - base, 1);
  app.advance(3500);
  await poll();
  assert.equal(app.ctx.gateway.statusCalls - base, 2);
});

test('pagamento: o gateway avisa pela URL do pedido e dispara Purchase (TikTok) e paid (UTMify)', async () => {
  const app = makeApp();
  const order = await app.createOrder();
  app.ctx.gateway.markPaid(order.gatewayId);

  const hook = await app.call('POST', app.postbackPath(order.gatewayId), { body: { gatewayId: order.gatewayId } });
  assert.equal(hook.status, 200);
  assert.equal(hook.json.ok, true);

  const status = await app.call('POST', '/api/shop/status/live', { body: { id: order.id, key: KEY } });
  assert.equal(status.json.status, 'paid');

  assert.equal(purchases(app).length, 1);
  const evt = purchases(app)[0].body.data[0];
  assert.equal(purchases(app)[0].headers['Access-Token'], 'tiktok-token');
  assert.equal(evt.event_id, `purchase_${order.gatewayId}`);
  assert.equal(evt.user.email, sha('maria@example.com'));
  assert.equal(evt.user.ttclid, 'CLICK123');
  assert.equal(evt.user.ttp, 'ttp-cookie-1');
  assert.equal(evt.user.ip, '203.0.113.7');
  assert.equal(evt.page.url, 'https://loja.test/checkout');
  assert.equal(evt.properties.value, 77.9);

  const [paid] = utmify(app, 'paid');
  assert.equal(paid.body.orderId, order.gatewayId);
  assert.ok(paid.body.approvedDate);
  assert.equal(paid.body.createdAt, utmify(app, 'waiting_payment')[0].body.createdAt, 'createdAt igual em todas as atualizações');
  assert.equal(paid.body.trackingParameters.utm_campaign, 'camp1');
});

test('pagamento: se a URL do webhook não trouxer o contexto, usa os metadados do gateway', async () => {
  const app = makeApp();
  const order = await app.createOrder();
  app.ctx.gateway.markPaid(order.gatewayId);
  const hook = await app.call('POST', app.postbackPath(order.gatewayId, { withContext: false }), { body: { gatewayId: order.gatewayId } });
  assert.equal(hook.status, 200);
  assert.equal(hook.json.ok, true);
  assert.equal(purchases(app).length, 1);
});

test('webhook: o corpo sozinho não vale, o gateway é consultado (pendente = nada é enviado)', async () => {
  const app = makeApp();
  const order = await app.createOrder();
  const hook = await app.call('POST', app.postbackPath(order.gatewayId), { body: { gatewayId: order.gatewayId, status: 'paid' } });
  assert.equal(hook.status, 200);
  assert.equal(purchases(app).length, 0);
  assert.equal(utmify(app, 'paid').length, 0);
});

test('webhook: token obrigatório quando configurado', async () => {
  const app = makeApp({ env: { WEBHOOK_TOKEN: 'segredo-do-webhook' } });
  const order = await app.createOrder();
  app.ctx.gateway.markPaid(order.gatewayId);
  const path = app.postbackPath(order.gatewayId);

  assert.equal((await app.call('POST', '/api/shop/webhook', { body: { gatewayId: order.gatewayId } })).status, 401);
  assert.equal((await app.call('POST', path.replace('segredo-do-webhook', 'errado'), { body: { gatewayId: order.gatewayId } })).status, 401);
  assert.equal(purchases(app).length, 0);
  assert.equal((await app.call('POST', path, { body: { gatewayId: order.gatewayId } })).status, 200);
  assert.equal(purchases(app).length, 1);
});

test('webhook: desconhecido, sem contexto e valor diferente são ignorados (200) sem enviar nada', async () => {
  const app = makeApp();
  const order = await app.createOrder();
  app.ctx.gateway.markPaid(order.gatewayId);

  const unknown = await app.call('POST', '/api/shop/webhook', { body: { gatewayId: 'mock_desconhecido' } });
  assert.deepEqual([unknown.status, unknown.json.ignored], [200, 'desconhecido']);
  assert.equal((await app.call('POST', '/api/shop/webhook', { body: {} })).json.ignored, 'sem-id');

  // Contexto de outro segredo na URL: se o gateway devolve os metadados, eles resgatam o pedido...
  const foreign = seal('outro-segredo-também-com-mais-de-32-chars', { total: 7790 });
  const rescued = await app.call('POST', `/api/shop/webhook?s=${foreign}`, { body: { gatewayId: order.gatewayId } });
  assert.equal(rescued.json.ignored, undefined);
  assert.equal(purchases(app).length, 1);
  app.calls.tiktok.length = 0;
  app.calls.utmify.length = 0;

  // ...e se ele não devolve nada utilizável, o aviso é ignorado.
  app.ctx.gateway.inspect(order.gatewayId).metadata = undefined;
  const noContext = await app.call('POST', `/api/shop/webhook?s=${foreign}`, { body: { gatewayId: order.gatewayId } });
  assert.equal(noContext.json.ignored, 'sem-contexto');

  app.ctx.gateway.inspect(order.gatewayId).amountCents = 100; // gateway diz que só 1 real foi pago
  const mismatch = await app.call('POST', app.postbackPath(order.gatewayId), { body: { gatewayId: order.gatewayId } });
  assert.equal(mismatch.json.ignored, 'valor-diferente');

  assert.equal(purchases(app).length, 0);
  assert.equal(utmify(app, 'paid').length, 0);
});

test('webhook: se o TikTok falhar responde 500 (o gateway reenvia) e a nova tentativa completa sem duplicar o evento', async () => {
  const app = makeApp({ failTikTok: true });
  const order = await app.createOrder();
  app.ctx.gateway.markPaid(order.gatewayId);
  const path = app.postbackPath(order.gatewayId);

  const failing = await app.call('POST', path, { body: { gatewayId: order.gatewayId } });
  assert.equal(failing.status, 500);

  app.setTikTokFailing(false);
  const retry = await app.call('POST', path, { body: { gatewayId: order.gatewayId } });
  assert.equal(retry.status, 200);

  // A tentativa repetida usa o mesmo event_id: o TikTok deduplica, então não há venda em dobro.
  const ids = new Set(purchases(app).map((c) => c.body.data[0].event_id));
  assert.deepEqual([...ids], [`purchase_${order.gatewayId}`]);
});

test('reembolso: avisa a UTMify e não repete o Purchase', async () => {
  const app = makeApp();
  const order = await app.createOrder();
  app.ctx.gateway.markPaid(order.gatewayId);
  await app.call('POST', app.postbackPath(order.gatewayId), { body: { gatewayId: order.gatewayId } });
  const purchasesBefore = purchases(app).length;

  app.ctx.gateway.setStatus(order.gatewayId, 'refunded');
  app.advance(61_000); // passa a validade do cache do status "paid"
  const hook = await app.call('POST', app.postbackPath(order.gatewayId), { body: { gatewayId: order.gatewayId } });
  assert.equal(hook.status, 200);
  assert.equal(utmify(app, 'refunded').length, 1);
  assert.ok(utmify(app, 'refunded')[0].body.refundedAt);
  assert.equal(purchases(app).length, purchasesBefore);
});

test('PIX vencido é exibido como expired', async () => {
  const app = makeApp();
  const order = await app.createOrder();
  app.advance(2 * 3600 * 1000);
  const status = await app.call('POST', '/api/shop/status/live', { body: { id: order.id, key: KEY } });
  assert.equal(status.json.status, 'expired');
});

test('simulação de pagamento local (mock-pay) percorre o mesmo caminho do webhook', async () => {
  const app = makeApp();
  const order = await app.createOrder();
  const pay = await app.call('POST', '/api/shop/dev/mock-pay', { body: { id: order.id } });
  assert.deepEqual([pay.json.ok, pay.json.status], [true, 'paid']);
  assert.equal((await app.call('POST', '/api/shop/status/live', { body: { id: order.id, key: KEY } })).json.status, 'paid');
  assert.equal(purchases(app).length, 1);
});

test('event: repassa ao TikTok com o event_id do navegador e valida o tipo', async () => {
  const app = makeApp();
  const body = { id: 'ic_abc12345', kind: 'InitiateCheckout', productId: 'armario-multiuso-misto', createdAt: Date.now() - 5000, attribution: { ttclid: 'CLICK9' } };

  const res = await app.call('POST', '/api/shop/event', { body });
  assert.deepEqual(res.json, { accepted: true, value: 7790 });
  const evt = app.calls.tiktok[0].body.data[0];
  assert.equal(evt.event, 'InitiateCheckout');
  assert.equal(evt.event_id, 'ic_abc12345');
  assert.equal(evt.user.ttclid, 'CLICK9');
  assert.equal(evt.user.ttp, 'ttp-cookie-1');
  assert.equal(evt.page.url, 'https://loja.test/checkout');

  assert.equal((await app.call('POST', '/api/shop/event', { body: { id: 'ic_abc12345', kind: 'Purchase' } })).status, 400, 'o navegador não pode forjar Purchase');
  assert.equal((await app.call('POST', '/api/shop/event', { body: { id: 'x', kind: 'ViewContent' } })).status, 400);
});

test('event: se o TikTok recusar, accepted=false para o front reenviar; depois aceita', async () => {
  const app = makeApp({ failTikTok: true });
  const body = { id: 'ic_retry_001', kind: 'InitiateCheckout' };
  const failed = await app.call('POST', '/api/shop/event', { body });
  assert.deepEqual(failed.json, { accepted: false, value: 7790 });
  app.setTikTokFailing(false);
  assert.equal((await app.call('POST', '/api/shop/event', { body })).json.accepted, true);
});

test('event: sem credenciais do TikTok aceita e não tenta enviar', async () => {
  const app = makeApp({ env: { TIKTOK_ACCESS_TOKEN: '' } });
  const res = await app.call('POST', '/api/shop/event', { body: { id: 'vc_semtoken1', kind: 'ViewContent' } });
  assert.deepEqual(res.json, { accepted: true, value: 7790 });
  assert.equal(app.calls.tiktok.length, 0);
});

test('limite: a partir da 31ª criação seguida do mesmo IP responde 429', async () => {
  const app = makeApp();
  let last;
  for (let i = 0; i < 31; i++) {
    last = await app.call('POST', '/api/shop/create', { body: validOrder({ key: `chave-numero-${String(i).padStart(4, '0')}-xxxxxxxx` }) });
  }
  assert.equal(last.status, 429);
});

test('saúde, rota inexistente, método errado e JSON quebrado', async () => {
  const { call } = makeApp();
  const ok = await call('GET', '/api/shop/health');
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.json.service, ok.json.status], ['facilitacasa', 'ok']);
  assert.equal((await call('GET', '/api/shop/nao-existe')).status, 404);
  assert.equal((await call('GET', '/api/shop/admin/orders')).status, 404, 'não existe listagem de pedidos (não há banco)');
  const wrong = await call('GET', '/api/shop/create');
  assert.deepEqual([wrong.status, wrong.headers.allow], [405, 'POST']);
  assert.equal((await call('POST', '/api/shop/create', { body: '{quebrado' })).status, 400);

  const noSecret = makeApp({ env: { STATE_SECRET: 'curto' } });
  assert.equal((await noSecret.call('GET', '/api/shop/health')).status, 503);
});

test('o gateway mock nunca liga em produção nem na Vercel', async () => {
  const { buildContext } = await import('../server/router.js');
  assert.throws(() => buildContext({ PAYMENT_GATEWAY: 'mock', VERCEL_ENV: 'production' }), /computador/);
  assert.throws(() => buildContext({ PAYMENT_GATEWAY: 'mock', VERCEL: '1', VERCEL_ENV: 'preview' }), /computador/);
  assert.equal(buildContext({ PAYMENT_GATEWAY: 'mock' }).gateway.name, 'mock');
  assert.equal(SECRET.length >= 32, true);
});
