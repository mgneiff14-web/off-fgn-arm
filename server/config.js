import { randomBytes } from 'node:crypto';

// Regras da loja + leitura das variáveis de ambiente.
//
// Valores em centavos. As regras de preço espelham o que o front-end mostra no
// checkout (kit x quantidade, cupom VOLTA25 = 25%, frete express = R$ 14,50).
// O servidor recalcula tudo: o total enviado pelo navegador nunca é usado.

export const CONTENT_ID = 'armario-multiuso'; // mesmo content_id do pixel no navegador
export const MAX_QUANTITY = 10;
export const SHIPPING = { standard: 0, express: 1450 };
export const COUPONS = { VOLTA25: 0.25 };

const base = {
  category: 'Organização para casa',
  price: 7790,
  stock: 50,
  sizes: ['Kit com 2 unidades'],
  active: true,
};

export const PRODUCTS = [
  {
    ...base,
    id: 'armario-multiuso-2-pretos',
    name: 'Armário Multiuso de Aço — 2 Pretos',
    image: '/img/variants/2-pretos.webp',
    colors: ['2 Pretos'],
    recommended: true,
    description: 'Kit com dois armários multiuso de aço na cor preta.',
  },
  {
    ...base,
    id: 'armario-multiuso-2-brancos',
    name: 'Armário Multiuso de Aço — 2 Brancos',
    image: '/img/variants/2-brancos.webp',
    colors: ['2 Brancos'],
    recommended: false,
    description: 'Kit com dois armários multiuso de aço na cor branca.',
  },
  {
    ...base,
    id: 'armario-multiuso-misto',
    name: 'Armário Multiuso de Aço — 1 Preto + 1 Branco',
    image: '/img/variants/misto.webp',
    colors: ['1 Preto + 1 Branco'],
    recommended: false,
    description: 'Kit misto com um armário preto e um armário branco.',
  },
];

const positive = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function loadConfig(env = process.env) {
  const onVercel = Boolean(env.VERCEL);
  const production = env.VERCEL_ENV === 'production' || env.NODE_ENV === 'production';

  // Na produção usa o domínio do projeto; em previews, o endereço próprio daquele deploy.
  const vercelHost = env.VERCEL_ENV === 'production' ? env.VERCEL_PROJECT_PRODUCTION_URL : env.VERCEL_URL;

  // Segredo que protege os tickets de pedido e o contexto enviado ao gateway. Precisa ter 32+
  // caracteres. Só em desenvolvimento local, sem segredo definido, gera um temporário.
  const stateSecret = env.STATE_SECRET || (!onVercel && !production ? randomBytes(32).toString('hex') : '');

  return {
    onVercel,
    production,
    gateway: (env.PAYMENT_GATEWAY || 'flevopay').trim().toLowerCase(),
    pixExpiresMinutes: positive(env.PIX_EXPIRES_MINUTES, 60),
    // URL pública usada para montar o webhook enviado ao gateway.
    publicBaseUrl: (env.PUBLIC_BASE_URL || (vercelHost ? `https://${vercelHost}` : '')).replace(/\/$/, ''),
    webhookToken: env.WEBHOOK_TOKEN || '',
    stateSecret,
    stateSecretOk: stateSecret.length >= 32,
    tiktok: {
      pixelId: env.TIKTOK_PIXEL_ID || '',
      accessToken: env.TIKTOK_ACCESS_TOKEN || '',
      testEventCode: env.TIKTOK_TEST_EVENT_CODE || '',
    },
    utmify: {
      token: env.UTMIFY_API_TOKEN || '',
      platform: env.UTMIFY_PLATFORM || 'FacilitaCasa',
      isTest: env.UTMIFY_IS_TEST === 'true',
    },
    flevopay: {
      apiKey: env.FLEVOPAY_API_KEY || '',
      baseUrl: (env.FLEVOPAY_BASE_URL || 'https://app.flevopay.com.br').replace(/\/$/, ''),
    },
  };
}
