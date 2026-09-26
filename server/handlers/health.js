// Endpoint público: só diz se o servidor está configurado para funcionar. Sem detalhes.
export async function health(ctx) {
  // Sem STATE_SECRET válido o servidor não consegue emitir nem ler pedidos.
  const degraded = !ctx.config.stateSecretOk;
  return {
    status: degraded ? 503 : 200,
    body: { service: 'facilitacasa', status: degraded ? 'degraded' : 'ok', time: new Date(ctx.now()).toISOString() },
  };
}
