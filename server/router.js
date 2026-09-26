import { loadConfig } from './config.js';
import { createGateway } from './gateways/index.js';
import { catalog } from './handlers/catalog.js';
import { create } from './handlers/create.js';
import { devMockPay } from './handlers/devMockPay.js';
import { event } from './handlers/event.js';
import { health } from './handlers/health.js';
import { statusLive } from './handlers/status.js';
import { webhook } from './handlers/webhook.js';
import { HttpError, clientIp, readBody, sendJson } from './http.js';
import { createTikTok } from './integrations/tiktok.js';
import { createUtmify } from './integrations/utmify.js';
import { createLimiter, createTtlCache } from './memory.js';

export const ROUTES = {
  'GET catalog': catalog,
  'GET health': health,
  'POST event': event,
  'POST create': create,
  'POST status/live': statusLive,
  'POST webhook': webhook,
  'POST dev/mock-pay': devMockPay,
};

// Tudo que os handlers usam vem deste objeto, o que permite trocar peças nos testes.
// Não há banco de dados: o estado do pedido vive no gateway, no ticket assinado que o
// navegador guarda e no contexto criptografado que volta pelo webhook.
export function buildContext(env = process.env, overrides = {}) {
  const config = loadConfig(env);
  const now = () => Date.now();
  return {
    config,
    gateway: createGateway(config),
    tiktok: createTikTok(config.tiktok),
    utmify: createUtmify(config.utmify),
    limiter: createLimiter(now),
    cache: createTtlCache(now),
    now,
    log: (level, message, meta = {}) =>
      console[level === 'error' ? 'error' : level === 'info' ? 'log' : 'warn'](`[loja] ${message} ${JSON.stringify(meta)}`),
    ...overrides,
  };
}

// Descobre a rota a partir da URL original (/api/shop/status/live -> "status/live").
export function resolveRoute(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const prefix = '/api/shop/';
  let path = '';
  if (url.pathname.startsWith(prefix)) path = url.pathname.slice(prefix.length);
  else if (req.query?.route) path = [].concat(req.query.route).join('/');
  url.searchParams.delete('route');
  return { route: path.replace(/^\/+|\/+$/g, ''), query: Object.fromEntries(url.searchParams) };
}

export function createHandler(context) {
  let ctx;
  const getContext = () => (ctx ??= typeof context === 'function' ? context() : (context ?? buildContext()));

  return async function handler(req, res) {
    try {
      const { route, query } = resolveRoute(req);
      const method = (req.method || 'GET').toUpperCase();
      const fn = ROUTES[`${method} ${route}`];

      if (!fn) {
        const allowed = Object.keys(ROUTES)
          .filter((key) => key.endsWith(` ${route}`))
          .map((key) => key.split(' ')[0]);
        if (allowed.length) return sendJson(res, 405, { error: 'Método não permitido.' }, { Allow: allowed.join(', ') });
        return sendJson(res, 404, { error: 'Rota não encontrada.' });
      }

      const { raw, data } = method === 'GET' ? { raw: '', data: {} } : await readBody(req);
      const result = await fn(getContext(), req, { data, raw, query, ip: clientIp(req) });
      return sendJson(res, result.status, result.body, result.headers);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error('[loja] erro inesperado:', err?.message);
      return sendJson(res, 500, { error: 'Erro interno. Tente novamente.' });
    }
  };
}
