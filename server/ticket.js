import { safeEqual } from './http.js';
import { sign } from './seal.js';

// O "id" que o front guarda do pedido é um ticket assinado, não uma linha de banco:
//   <id do gateway>.<criado em>.<expira em>.<total>[.<código pix>].<assinatura>
// A assinatura cobre o conteúdo E a chave secreta do navegador (`key`), então só quem gerou o
// pedido consegue consultá-lo, e ninguém consegue alterar total ou validade.
// Números em base 36 e texto em base64url mantêm o id curto (o front o usa em ids de evento).

const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64url');
const unb64 = (text) => Buffer.from(text, 'base64url').toString('utf8');

export function makeTicketId(secret, { g, ca, ea, tot, pix }, key) {
  const parts = [b64(g), ca.toString(36), ea.toString(36), tot.toString(36)];
  if (pix) parts.push(b64(pix));
  const body = parts.join('.');
  return `${body}.${sign(secret, `${body}:${key}`)}`;
}

function decode(parts) {
  const [g, ca, ea, tot, pix] = parts;
  const ticket = { g: unb64(g), ca: parseInt(ca, 36), ea: parseInt(ea, 36), tot: parseInt(tot, 36), pix: pix ? unb64(pix) : '' };
  const valid = ticket.g && [ticket.ca, ticket.ea, ticket.tot].every(Number.isFinite);
  return valid ? ticket : null;
}

export function readTicketId(secret, id, key) {
  if (!secret || typeof id !== 'string' || id.length > 2000) return null;
  const parts = id.split('.');
  if (parts.length < 5 || parts.length > 6) return null;
  const signature = parts.pop();
  if (!safeEqual(signature, sign(secret, `${parts.join('.')}:${key}`))) return null;
  return decode(parts);
}

// Só para a rota de simulação de pagamento (desenvolvimento): lê sem exigir a chave.
export function peekTicketId(id) {
  if (typeof id !== 'string' || id.length > 2000) return null;
  const parts = id.split('.');
  if (parts.length < 5 || parts.length > 6) return null;
  parts.pop();
  return decode(parts);
}
