export const onlyDigits = (value) => String(value ?? '').replace(/\D/g, '');

export function isValidCpf(value) {
  const d = onlyDigits(value);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    if (((sum * 10) % 11) % 10 !== Number(d[len])) return false;
  }
  return true;
}

export const isValidEmail = (value) =>
  typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);

// Telefone brasileiro com DDD: 10 ou 11 dígitos. Aceita o prefixo 55 e o remove.
export function normalizePhone(value) {
  let d = onlyDigits(value);
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? d : '';
}

// Campos de atribuição que o front-end guarda (UTMs, ttclid e ids de campanha).
export const ATTRIBUTION_KEYS = [
  'src', 'sck', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id',
  'ttclid', 'campaign_id', 'adgroup_id', 'adset_id', 'ad_id', 'campaign_name', 'adset_name', 'ad_name',
];

export function cleanAttribution(input, maxLength = 500) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of ATTRIBUTION_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) out[key] = value.trim().slice(0, maxLength);
  }
  return out;
}
