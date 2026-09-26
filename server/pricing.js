import { COUPONS, MAX_QUANTITY, PRODUCTS, SHIPPING } from './config.js';
import { HttpError } from './http.js';

export const findProduct = (id) => PRODUCTS.find((p) => p.id === id && p.active) || null;
export const defaultProduct = () => PRODUCTS.find((p) => p.recommended && p.active) || PRODUCTS[0];

// Mesma conta do checkout: subtotal - desconto do cupom + frete (tudo em centavos).
export function priceOrder({ productId, quantity, shipping, coupon }) {
  const product = findProduct(productId);
  if (!product) throw new HttpError(400, 'Produto indisponível.');

  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) {
    throw new HttpError(400, 'Quantidade inválida.');
  }

  const shippingMethod = shipping === 'express' ? 'express' : 'standard';
  const rate = COUPONS[String(coupon || '').toUpperCase()] || 0;
  const subtotal = product.price * qty;
  const discount = Math.round(subtotal * rate);
  const shippingCents = SHIPPING[shippingMethod];

  return {
    product,
    quantity: qty,
    shippingMethod,
    coupon: rate ? String(coupon).toUpperCase() : '',
    subtotal,
    discount,
    shipping: shippingCents,
    total: subtotal - discount + shippingCents,
  };
}
