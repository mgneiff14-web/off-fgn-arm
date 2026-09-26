import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createTikTok, hashEmail, hashPhone } from '../server/integrations/tiktok.js';
import { buildOrderPayload, utcStamp } from '../server/integrations/utmify.js';
import { createLimiter, createTtlCache } from '../server/memory.js';
import { priceOrder } from '../server/pricing.js';
import { open, seal } from '../server/seal.js';
import { makeTicketId, peekTicketId, readTicketId } from '../server/ticket.js';
import { cleanAttribution, isValidCpf, isValidEmail, normalizePhone } from '../server/validators.js';
import { SECRET } from './helpers.js';

const sha = (v) => createHash('sha256').update(v).digest('hex');

test('CPF: aceita válido (com e sem máscara) e rejeita inválidos', () => {
  assert.equal(isValidCpf('529.982.247-25'), true);
  assert.equal(isValidCpf('52998224725'), true);
  assert.equal(isValidCpf('52998224724'), false);
  assert.equal(isValidCpf('11111111111'), false);
  assert.equal(isValidCpf('123'), false);
});

test('telefone e e-mail', () => {
  assert.equal(normalizePhone('(44) 99990-7675'), '44999907675');
  assert.equal(normalizePhone('+55 44 99990-7675'), '44999907675');
  assert.equal(normalizePhone('99990'), '');
  assert.equal(isValidEmail('a@b.co'), true);
  assert.equal(isValidEmail('a@b'), false);
});

test('atribuição: só chaves conhecidas, com limite de tamanho', () => {
  const out = cleanAttribution({ utm_source: ' tiktok ', ttclid: 'x'.repeat(900), hack: 'y', utm_medium: 5 });
  assert.deepEqual(Object.keys(out).sort(), ['ttclid', 'utm_source']);
  assert.equal(out.utm_source, 'tiktok');
  assert.equal(out.ttclid.length, 500);
  assert.equal(cleanAttribution({ ttclid: 'x'.repeat(900) }, 200).ttclid.length, 200);
});

test('preço: mesma conta do checkout (cupom VOLTA25 e frete express)', () => {
  const base = { productId: 'armario-multiuso-2-pretos' };
  assert.equal(priceOrder({ ...base, quantity: 1, shipping: 'standard' }).total, 7790);
  const p = priceOrder({ ...base, quantity: 2, shipping: 'express', coupon: 'volta25' });
  assert.equal(p.subtotal, 15580);
  assert.equal(p.discount, 3895);
  assert.equal(p.total, 15580 - 3895 + 1450);
  assert.equal(priceOrder({ ...base, quantity: 1, coupon: 'INVENTADO' }).discount, 0);
  assert.throws(() => priceOrder({ ...base, quantity: 11 }), /Quantidade/);
  assert.throws(() => priceOrder({ ...base, quantity: 0 }), /Quantidade/);
  assert.throws(() => priceOrder({ productId: 'nao-existe', quantity: 1 }), /Produto/);
});

test('seal: ida e volta; adulteração, segredo errado e lixo são rejeitados', () => {
  const value = { nome: 'João Ação', total: 7790, nested: { a: [1, 2, 3] } };
  const token = seal(SECRET, value);
  assert.deepEqual(open(SECRET, token), value);
  assert.notEqual(seal(SECRET, value), token, 'IV aleatório: cada selo é diferente');
  assert.equal(open('outro-segredo-também-com-mais-de-32-chars', token), null);
  const i = 40;
  const tampered = token.slice(0, i) + (token[i] === 'A' ? 'B' : 'A') + token.slice(i + 1);
  assert.equal(open(SECRET, tampered), null);
  assert.equal(open(SECRET, 'lixo'), null);
  assert.equal(open(SECRET, ''), null);
  assert.equal(open(SECRET, 'A'.repeat(9000)), null);
  assert.equal(open('', token), null);
  assert.ok(!/[^A-Za-z0-9_-]/.test(token), 'seguro para usar em URL');
});

test('ticket: assinado junto com a chave do navegador; total e validade não podem ser alterados', () => {
  const key = 'a3f1c2d4-5b6e-4f70-8a9b-0c1d2e3f4a5b';
  const t = { g: 'tx_123-ABC', ca: 1790000000000, ea: 1790003600000, tot: 13135, pix: '' };
  const id = makeTicketId(SECRET, t, key);
  assert.ok(id.length < 120, `id curto (${id.length})`);
  assert.deepEqual(readTicketId(SECRET, id, key), t);
  assert.equal(readTicketId(SECRET, id, 'outra-chave-qualquer-123'), null);
  assert.equal(readTicketId('outro-segredo-também-com-mais-de-32-chars', id, key), null);

  const parts = id.split('.');
  parts[3] = (1).toString(36); // tenta baixar o total
  assert.equal(readTicketId(SECRET, parts.join('.'), key), null);
  assert.equal(readTicketId(SECRET, 'abc', key), null);

  const withPix = makeTicketId(SECRET, { ...t, pix: '000201...COPIACOLA' }, key);
  assert.equal(readTicketId(SECRET, withPix, key).pix, '000201...COPIACOLA');
  assert.equal(peekTicketId(withPix).g, 'tx_123-ABC');
});

test('limitador e cache em memória', () => {
  let t = 0;
  const allow = createLimiter(() => t);
  assert.deepEqual([1, 2, 3, 4].map(() => allow('ip', 3, 1000)), [true, true, true, false]);
  t += 1001;
  assert.equal(allow('ip', 3, 1000), true, 'janela nova');

  const cache = createTtlCache(() => t);
  cache.set('k', 'v', 3000);
  assert.equal(cache.get('k'), 'v');
  t += 3001;
  assert.equal(cache.get('k'), undefined);
  cache.set('k', 'v2', 3000);
  cache.delete('k');
  assert.equal(cache.get('k'), undefined);
});

test('TikTok: hash de e-mail/telefone e formato do corpo', () => {
  assert.equal(hashEmail('  Maria@Example.COM '), sha('maria@example.com'));
  assert.equal(hashPhone('44999907675'), sha('+5544999907675'));
  assert.equal(hashPhone('5544999907675'), sha('+5544999907675'));

  const tiktok = createTikTok({ pixelId: 'PX', accessToken: 'T', testEventCode: 'TEST1' });
  const body = tiktok.buildBody({
    event: 'Purchase', eventId: 'purchase_1', time: 1700000000,
    user: { email: 'a@b.co', phone: '44999907675', ip: '1.2.3.4', userAgent: 'UA', ttclid: 'C', ttp: 'P' },
    value: 7790, quantity: 1, productName: 'Armário', page: { url: 'https://x.test/' },
  });
  assert.equal(body.event_source, 'web');
  assert.equal(body.event_source_id, 'PX');
  assert.equal(body.test_event_code, 'TEST1');
  const [evt] = body.data;
  assert.equal(evt.event, 'Purchase');
  assert.equal(evt.event_id, 'purchase_1');
  assert.equal(evt.user.email, sha('a@b.co'));
  assert.equal(evt.user.ip, '1.2.3.4');
  assert.equal(evt.properties.value, 77.9);
  assert.equal(evt.properties.currency, 'BRL');
  assert.equal(evt.properties.contents[0].content_id, 'armario-multiuso');
});

test('TikTok: sem credenciais pula; erro da API vira ok:false sem lançar', async () => {
  assert.deepEqual(await createTikTok({}).send({}), { ok: true, skipped: true });
  const failing = createTikTok({ pixelId: 'PX', accessToken: 'T' }, async () => ({ ok: false, status: 401, json: async () => ({ code: 40105, message: 'token' }) }));
  assert.equal((await failing.send({ event: 'ViewContent', eventId: 'e', time: 1, value: 1 })).ok, false);
  const broken = createTikTok({ pixelId: 'PX', accessToken: 'T' }, async () => { throw new Error('rede'); });
  assert.equal((await broken.send({ event: 'ViewContent', eventId: 'e', time: 1, value: 1 })).ok, false);
});

test('UTMify: formato do pedido conforme a documentação', () => {
  assert.equal(utcStamp(Date.UTC(2026, 8, 26, 14, 5, 9)), '2026-09-26 14:05:09');
  const order = {
    id: 'o1', createdAt: Date.UTC(2026, 8, 26, 14, 0, 0), paidAt: Date.UTC(2026, 8, 26, 14, 1, 0),
    customer: { name: 'Maria Silva', email: 'm@x.co', phone: '44999907675', cpf: '52998224725' },
    productId: 'armario-multiuso-2-pretos', productName: 'Armário', quantity: 2, total: 11685,
    attribution: { utm_source: 'tiktok', src: 's' }, gateway: { feeCents: 200 }, tracking: { ip: '1.2.3.4' },
  };
  const paid = buildOrderPayload(order, 'paid', { platform: 'FacilitaCasa', isTest: false });
  assert.equal(paid.paymentMethod, 'pix');
  assert.equal(paid.status, 'paid');
  assert.equal(paid.createdAt, '2026-09-26 14:00:00');
  assert.equal(paid.approvedDate, '2026-09-26 14:01:00');
  assert.equal(paid.refundedAt, null);
  assert.equal(paid.customer.document, '52998224725');
  assert.equal(paid.trackingParameters.utm_source, 'tiktok');
  assert.equal(paid.trackingParameters.utm_medium, null);
  assert.deepEqual(paid.commission, { totalPriceInCents: 11685, gatewayFeeInCents: 200, userCommissionInCents: 11485 });
  const waiting = buildOrderPayload(order, 'waiting_payment', { platform: 'FacilitaCasa', isTest: false });
  assert.equal(waiting.approvedDate, null);
  assert.equal(waiting.createdAt, paid.createdAt); // createdAt deve ser igual em todas as atualizações
});
