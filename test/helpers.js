import { loadConfig } from '../server/config.js';
import { createGateway } from '../server/gateways/index.js';
import { createTikTok } from '../server/integrations/tiktok.js';
import { createUtmify } from '../server/integrations/utmify.js';
import { createLimiter, createTtlCache } from '../server/memory.js';
import { createHandler } from '../server/router.js';
import { peekTicketId } from '../server/ticket.js';

export const VALID_CPF = '52998224725';
export const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres!';

export const validOrder = (overrides = {}) => ({
  kit: { id: 'armario-multiuso-2-pretos', quantity: 1, shipping: 'standard', coupon: '' },
  customer: { name: 'Maria Silva', email: 'Maria@Example.com', phone: '(44) 99990-7675', cpf: VALID_CPF },
  address: { cep: '87020-000', street: 'Rua das Flores', number: '100', extra: '', district: 'Centro', city: 'Maringá', state: 'PR' },
  key: 'a3f1c2d4-5b6e-4f70-8a9b-0c1d2e3f4a5b',
  attribution: { utm_source: 'tiktok', utm_campaign: 'camp1', ttclid: 'CLICK123' },
  recoveryConsent: true,
  ...overrides,
});

// Monta um app completo sem rede: gateway mock em memória e TikTok/UTMify gravando as
// chamadas em `calls` em vez de sair para a internet. Não existe banco de dados para simular.
export function makeApp({ env = {}, failTikTok = false, gatewayFetch } = {}) {
  const config = loadConfig({
    PAYMENT_GATEWAY: 'mock',
    STATE_SECRET: SECRET,
    PUBLIC_BASE_URL: 'https://loja.test',
    TIKTOK_PIXEL_ID: 'PIXEL123',
    TIKTOK_ACCESS_TOKEN: 'tiktok-token',
    UTMIFY_API_TOKEN: 'utmify-token',
    ...env,
  });
  const state = { failTikTok, offset: 0 };
  const now = () => Date.now() + state.offset;
  const calls = { tiktok: [], utmify: [] };

  const fakeFetch = (bucket) => async (url, init) => {
    calls[bucket].push({ url, headers: init.headers, body: JSON.parse(init.body) });
    if (bucket === 'tiktok' && state.failTikTok) return { ok: false, status: 500, json: async () => ({ code: 40000 }) };
    return { ok: true, status: 200, json: async () => ({ code: 0 }) };
  };

  const ctx = {
    config,
    gateway: createGateway(config, gatewayFetch),
    tiktok: createTikTok(config.tiktok, fakeFetch('tiktok')),
    utmify: createUtmify(config.utmify, fakeFetch('utmify')),
    limiter: createLimiter(now),
    cache: createTtlCache(now),
    now,
    log: () => {},
  };
  const handler = createHandler(ctx);

  async function call(method, path, { body, headers = {} } = {}) {
    const req = {
      method,
      url: path,
      headers: {
        'user-agent': 'TestBrowser/1.0',
        'x-forwarded-for': '203.0.113.7',
        referer: 'https://loja.test/checkout',
        cookie: '_ttp=ttp-cookie-1',
        ...headers,
      },
      body,
    };
    let text = '';
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      end(chunk) { text = chunk ?? ''; },
    };
    await handler(req, res);
    let json = null;
    try { json = JSON.parse(text); } catch { /* corpo não é JSON */ }
    return { status: res.statusCode, json, text, headers: res.headers };
  }

  // Cria um pedido válido e devolve a resposta do create + o id do gateway por trás do ticket.
  async function createOrder(overrides) {
    const res = await call('POST', '/api/shop/create', { body: validOrder(overrides) });
    if (res.status !== 200) throw new Error(`create falhou: ${res.status} ${res.text}`);
    return { ...res.json, gatewayId: peekTicketId(res.json.id).g };
  }

  // O que o gateway real faz: o cliente paga no banco e o gateway chama a postbackUrl do pedido.
  function postbackPath(gatewayId, { withContext = true } = {}) {
    const url = new URL(ctx.gateway.inspect(gatewayId).postbackUrl);
    if (!withContext) url.searchParams.delete('s');
    return url.pathname + url.search;
  }

  return {
    ctx,
    calls,
    call,
    createOrder,
    postbackPath,
    advance: (ms) => { state.offset += ms; },
    setTikTokFailing: (value) => { state.failTikTok = value; },
  };
}
