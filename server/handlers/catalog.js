import { PRODUCTS } from '../config.js';

export async function catalog(ctx) {
  const payable = ctx.gateway.configured && ctx.config.stateSecretOk;
  return {
    status: 200,
    // Cache curto na borda: o front pede o catálogo em várias páginas e ele muda raramente.
    headers: { 'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300' },
    body: {
      products: PRODUCTS.map((p) => ({ ...p, payable })),
      paymentConfigured: payable,
      pixelId: ctx.config.tiktok.pixelId,
    },
  };
}
