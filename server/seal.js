import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

// Sem banco de dados, o contexto do pedido (cliente, endereço, UTMs, dados do navegador) viaja
// dentro da URL do webhook e/ou nos metadados do gateway. Para que isso seja seguro ele vai
// comprimido e criptografado com AES-256-GCM: ninguém lê e ninguém altera sem a STATE_SECRET.

const MAX_SEALED_LENGTH = 8000;
const MAX_PLAIN_BYTES = 64 * 1024;

const deriveKey = (secret) => createHash('sha256').update(`facilitacasa:seal:v1:${secret}`).digest();

export function seal(secret, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const packed = deflateRawSync(Buffer.from(JSON.stringify(value), 'utf8'));
  const body = Buffer.concat([cipher.update(packed), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

// Devolve o objeto original, ou null se o texto foi adulterado, veio de outro segredo ou é lixo.
export function open(secret, token) {
  try {
    if (!secret || typeof token !== 'string' || !token || token.length > MAX_SEALED_LENGTH) return null;
    const raw = Buffer.from(token, 'base64url');
    if (raw.length < 12 + 16 + 1) return null;
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const packed = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    const json = inflateRawSync(packed, { maxOutputLength: MAX_PLAIN_BYTES }).toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Assinatura curta (HMAC-SHA256, 132 bits) usada nos tickets de pedido.
export function sign(secret, text) {
  return createHmac('sha256', secret).update(text).digest('base64url').slice(0, 22);
}
