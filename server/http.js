import { createHash, timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(JSON.stringify(body));
}

const MAX_BODY_BYTES = 64 * 1024;

function parseBody(raw, contentType = '') {
  const text = String(raw ?? '').trim();
  if (!text) return {};
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
}

// Lê o corpo da requisição. Tenta o stream primeiro (assim o corpo bruto fica
// disponível para validar assinaturas de webhook) e cai para req.body, que é o
// que a Vercel entrega já interpretado.
export async function readBody(req) {
  let raw = null;
  if (typeof req[Symbol.asyncIterator] === 'function' && !req.readableEnded) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Requisição muito grande.');
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  } else if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') raw = req.body;
    else if (Buffer.isBuffer(req.body)) raw = req.body.toString('utf8');
    else raw = JSON.stringify(req.body);
  }
  const data = parseBody(raw, req.headers?.['content-type'] || '');
  return { raw: raw ?? '', data: data && typeof data === 'object' ? data : {} };
}

export function clientIp(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.headers?.['x-real-ip'] || '') || req.socket?.remoteAddress || '';
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    try {
      cookies[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      cookies[name] = part.slice(i + 1).trim();
    }
  }
  return cookies;
}

// Comparação em tempo constante (compara os hashes, então o tamanho não vaza).
export function safeEqual(a, b) {
  const digest = (v) => createHash('sha256').update(String(v ?? '')).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
