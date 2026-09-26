import { randomBytes } from 'node:crypto';
import { sendCreatedEffects } from '../effects.js';
import { HttpError, parseCookies } from '../http.js';
import { priceOrder } from '../pricing.js';
import { seal } from '../seal.js';
import { makeTicketId } from '../ticket.js';
import { cleanAttribution, isValidCpf, isValidEmail, normalizePhone, onlyDigits } from '../validators.js';

const KEY_RE = /^[A-Za-z0-9-]{16,64}$/;
const text = (value, max) => String(value ?? '').trim().slice(0, max);

// As mensagens são as mesmas do formulário do checkout, então o cliente vê o mesmo texto
// venha o erro do navegador ou do servidor.
function parseInput(data) {
  const key = String(data.key ?? '');
  if (!KEY_RE.test(key)) throw new HttpError(400, 'Requisição inválida.');

  const kit = data.kit && typeof data.kit === 'object' ? data.kit : {};
  const c = data.customer && typeof data.customer === 'object' ? data.customer : {};
  const a = data.address && typeof data.address === 'object' ? data.address : {};

  const customer = {
    name: text(c.name, 120),
    email: text(c.email, 254).toLowerCase(),
    phone: normalizePhone(c.phone),
    cpf: onlyDigits(c.cpf),
  };
  const address = {
    cep: onlyDigits(a.cep),
    street: text(a.street, 160),
    number: text(a.number, 20),
    extra: text(a.extra, 80),
    district: text(a.district, 80),
    city: text(a.city, 80),
    state: text(a.state, 2).toUpperCase(),
  };

  if (customer.name.split(/\s+/).length < 2) throw new HttpError(400, 'Insira seu nome completo (nome e sobrenome)');
  if (!customer.phone) throw new HttpError(400, 'Insira um telefone válido com DDD');
  if (!isValidEmail(customer.email)) throw new HttpError(400, 'Insira um e-mail válido');
  if (!isValidCpf(customer.cpf)) throw new HttpError(400, 'Insira um CPF válido');
  if (address.cep.length !== 8) throw new HttpError(400, 'Insira um CEP válido');
  if (!/^[A-Z]{2}$/.test(address.state)) throw new HttpError(400, 'Selecione o estado (UF)');
  if (!address.city) throw new HttpError(400, 'Insira a cidade');
  if (!address.district) throw new HttpError(400, 'Insira o bairro');
  if (!address.street) throw new HttpError(400, 'Insira o endereço');
  if (!address.number) throw new HttpError(400, 'Insira o número');

  return {
    key,
    kit: { productId: text(kit.id, 80), quantity: kit.quantity, shipping: kit.shipping, coupon: text(kit.coupon, 30) },
    customer,
    address,
    // Valores curtos: este contexto viaja dentro da URL do webhook.
    attribution: cleanAttribution(data.attribution, 200),
    recoveryConsent: data.recoveryConsent === true,
  };
}

function webhookUrl(ctx, sealed) {
  if (!ctx.config.publicBaseUrl) return '';
  const url = new URL('/api/shop/webhook', ctx.config.publicBaseUrl);
  if (ctx.config.webhookToken) url.searchParams.set('token', ctx.config.webhookToken);
  url.searchParams.set('s', sealed);
  return url.toString();
}

// Sem banco, o "pedido" é o que o gateway guarda + o contexto criptografado que viaja no webhook
// e o ticket assinado que o navegador guarda como id.
export async function create(ctx, req, { data, ip }) {
  if (!ctx.gateway.configured || !ctx.config.stateSecretOk) {
    throw new HttpError(503, 'Pagamento indisponível no momento. Tente novamente em instantes.');
  }
  if (!ctx.limiter(`create:${ip}`, 30, 10 * 60_000)) {
    throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos e tente novamente.');
  }

  const input = parseInput(data);
  const price = priceOrder(input.kit);
  const now = ctx.now();
  const secret = ctx.config.stateSecret;

  const context = {
    createdAt: now,
    productId: price.product.id,
    productName: price.product.name,
    quantity: price.quantity,
    shippingMethod: price.shippingMethod,
    coupon: price.coupon,
    subtotal: price.subtotal,
    discount: price.discount,
    shipping: price.shipping,
    total: price.total,
    customer: input.customer,
    address: input.address,
    attribution: input.attribution,
    recoveryConsent: input.recoveryConsent,
    // Dados do navegador guardados para o evento Purchase do TikTok, enviado só quando o PIX é pago.
    tracking: {
      ip,
      userAgent: (req.headers['user-agent'] || '').slice(0, 200),
      ttp: parseCookies(req.headers.cookie)._ttp || '',
      page: (req.headers.referer || '').slice(0, 200),
    },
  };
  const sealed = seal(secret, context);

  let pix;
  try {
    pix = await ctx.gateway.createPix({
      // Única por tentativa: um reenvio depois de falha de rede gera nova cobrança em vez de
      // ser recusado como referência repetida.
      reference: `ord_${now.toString(36)}${randomBytes(6).toString('hex')}`,
      amountCents: price.total,
      customer: input.customer,
      address: input.address,
      attribution: input.attribution,
      description: `${price.product.name} x${price.quantity}`,
      postbackUrl: webhookUrl(ctx, sealed),
      metadata: sealed,
      expiresInMinutes: ctx.config.pixExpiresMinutes,
    });
  } catch (err) {
    ctx.log('error', 'gateway não gerou o PIX', { error: err.message });
    throw new HttpError(502, 'Não foi possível gerar o Pix. Tente novamente.');
  }

  const expiresAt = pix.expiresAt || now + ctx.config.pixExpiresMinutes * 60_000;

  // Acessório: se a UTMify falhar, o PIX continua válido e pagável.
  await sendCreatedEffects(ctx, { ...context, id: pix.gatewayId });

  const id = makeTicketId(
    secret,
    {
      g: pix.gatewayId,
      ca: now,
      ea: expiresAt,
      tot: price.total,
      // Gateway que não devolve o código no status: ele viaja no próprio id.
      pix: ctx.gateway.statusReturnsPixCode ? '' : pix.pixCode,
    },
    input.key,
  );

  return { status: 200, body: { id, status: 'pending', pixCode: pix.pixCode, total: price.total, createdAt: now, expiresAt } };
}
