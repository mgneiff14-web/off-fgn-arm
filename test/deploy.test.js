import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ROUTES } from '../server/router.js';

const root = path.resolve(import.meta.dirname, '..');

// Motivo deste teste: na Vercel um catch-all `[...route].js` só atendeu rotas de UM segmento e
// `/api/shop/status/live` (dois segmentos) virou 404 da plataforma. Cada rota precisa do seu arquivo.
const productionRoutes = Object.keys(ROUTES)
  .map((key) => key.split(' '))
  .filter(([, route]) => !route.startsWith('dev/'));

test('toda rota de produção tem o seu arquivo de função em api/shop/', () => {
  for (const [method, route] of productionRoutes) {
    const file = path.join(root, 'api', 'shop', `${route}.js`);
    assert.ok(existsSync(file), `${method} /api/shop/${route} não tem arquivo: api/shop/${route}.js`);
  }
});

test('não há catch-all com colchetes em api/ (a Vercel não o resolve em rotas com mais de um segmento)', () => {
  assert.equal(existsSync(path.join(root, 'api', 'shop', '[...route].js')), false);
  assert.equal(readFileSync(path.join(root, 'vercel.json'), 'utf8').includes('[...'), false, 'vercel.json não deve citar arquivos [...param]');
});

test('cada arquivo de função importa o roteador certo e responde a sua própria rota', async () => {
  const calls = {
    catalog: ['GET', undefined, 200],
    health: ['GET', undefined, 200],
    event: ['POST', {}, 400],
    create: ['POST', {}, 503], // gateway da FlevoPay ainda sem chave neste ambiente de teste
    webhook: ['POST', {}, 200],
    'status/live': ['POST', { id: 'x', key: 'y' }, 404],
  };
  for (const [method, route] of productionRoutes) {
    const [expectedMethod, body, expectedStatus] = calls[route];
    assert.equal(method, expectedMethod);
    const mod = await import(pathToFileURL(path.join(root, 'api', 'shop', `${route}.js`)).href);
    let text = '';
    const res = { statusCode: 0, setHeader() {}, end(chunk) { text = chunk; } };
    await mod.default({ method, url: `/api/shop/${route}`, headers: { 'x-forwarded-for': '203.0.113.9' }, body }, res);
    assert.equal(res.statusCode, expectedStatus, `${route}: ${text}`);
    assert.doesNotThrow(() => JSON.parse(text), `${route} deve responder JSON`);
  }
});

test('CSP: cada script inline de cada HTML tem o hash liberado no vercel.json', async () => {
  const { createHash } = await import('node:crypto');
  const { readdirSync, statSync } = await import('node:fs');
  const vercel = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const csp = vercel.headers.find((h) => h.source === '/(.*)').headers.find((h) => h.key === 'Content-Security-Policy').value;

  const htmls = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.html')) htmls.push(full);
    }
  };
  walk(path.join(root, 'public'));
  assert.ok(htmls.length >= 11, `esperava 11+ HTMLs, achei ${htmls.length}`);

  for (const file of htmls) {
    const html = readFileSync(file, 'utf8');
    for (const [, body] of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      const hash = `'sha256-${createHash('sha256').update(body).digest('base64')}'`;
      assert.ok(csp.includes(hash), `${path.relative(root, file)}: script inline sem hash no CSP (${hash})`);
    }
  }
  assert.ok(csp.includes('https://*.tiktokw.us'), 'o pixel do TikTok usa analytics-ipv6.tiktokw.us');
});
