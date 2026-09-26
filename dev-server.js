// Servidor local: serve o site (pasta public/) e a API em /api/shop/*, como a Vercel faz.
// Uso: node dev-server.js   (lê variáveis do arquivo .env, se existir)
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile(new URL('./.env', import.meta.url));
} catch {
  // sem .env: segue com as variáveis do ambiente
}

const { createHandler } = await import('./server/router.js');

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 3000;
const api = createHandler();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

async function tryRead(file) {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

async function serveStatic(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const target = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.statusCode = 403;
    return res.end('Proibido');
  }
  // arquivo exato -> index.html da pasta -> index.html da raiz (rotas do React)
  const candidates = [target, path.join(target, 'index.html'), path.join(PUBLIC_DIR, 'index.html')];
  for (const file of candidates) {
    const body = await tryRead(file);
    if (body) {
      res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
      return res.end(body);
    }
  }
  res.statusCode = 404;
  res.end('Não encontrado');
}

http
  .createServer((req, res) => {
    if (req.url.startsWith('/api/shop/')) return api(req, res);
    return serveStatic(req, res);
  })
  .listen(PORT, () => console.log(`Loja local em http://localhost:${PORT}`));
