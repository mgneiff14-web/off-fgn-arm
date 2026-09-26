// Peças de memória do processo. Servem só como otimização/proteção "de melhor esforço": na Vercel
// cada instância tem a sua, então nada aqui pode ser a única fonte de verdade de um pedido.

// Limite de requisições por chave dentro de uma janela de tempo.
export function createLimiter(now = () => Date.now()) {
  const buckets = new Map();
  return function allow(key, max, windowMs) {
    const t = now();
    if (buckets.size > 5000) {
      for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
    }
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      buckets.set(key, { count: 1, resetAt: t + windowMs });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= max;
  };
}

// Cache com validade. Evita consultar o gateway a cada segundo por cliente na tela do PIX.
export function createTtlCache(now = () => Date.now()) {
  const entries = new Map();
  return {
    get(key) {
      const e = entries.get(key);
      if (!e) return undefined;
      if (e.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return e.value;
    },
    set(key, value, ttlMs) {
      if (entries.size > 2000) {
        const t = now();
        for (const [k, e] of entries) if (e.expiresAt <= t) entries.delete(k);
      }
      entries.set(key, { value, expiresAt: now() + ttlMs });
    },
    delete(key) {
      entries.delete(key);
    },
  };
}
