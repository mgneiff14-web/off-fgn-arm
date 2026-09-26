# Loja FacilitaCasa — site + backend de PIX e tracking

Site estático (React já compilado, em `public/`) + backend em funções da Vercel (`api/` e `server/`).
O front chama `/api/shop/*` no próprio domínio, então não há CORS nem URL de API para configurar.

**Não usa banco de dados nem serviço externo além do gateway de PIX, do TikTok e da UTMify.**

## Estrutura

```
public/        site publicado (index.html, assets/, img/ e uma pasta por rota do React)
api/shop/      uma função da Vercel por rota (catalog, event, create, webhook, health e status/live)
server/        lógica: preço, gateways de PIX, TikTok, UTMify, criptografia do contexto
test/          testes automatizados (node --test)
dev-server.js  servidor local: site + API
vercel.json    pasta de saída, região (São Paulo), cabeçalhos de segurança e CSP
```

`public/` é a única pasta servida como arquivo. O código de `api/` e `server/` nunca fica acessível pelo navegador.

**Rota nova = arquivo novo em `api/shop/`** (dois `import`/`export` de duas linhas, veja `api/shop/create.js`). Não use um
arquivo catch-all `[...route].js`: na Vercel ele só atendeu rotas de um segmento, e `/api/shop/status/live` virou 404 da
plataforma. `test/deploy.test.js` falha se alguma rota ficar sem arquivo.

## Como funciona sem banco

Cada requisição na Vercel roda numa função sem memória entre uma e outra. Em vez de guardar o pedido, o servidor
o distribui em três lugares:

1. **No gateway (FlevoPay):** é a fonte da verdade do pagamento (pendente, pago, reembolsado...). A tela do PIX
   pergunta o status ao gateway, com cache de 3 s por instância.
2. **No `id` do pedido, que o navegador guarda:** um ticket assinado (`id do gateway` + criado em + expira em + total),
   válido só junto com a chave secreta daquele navegador. Ninguém adultera total ou validade, e um id descoberto
   não serve para consultar o pedido de outra pessoa.
3. **No próprio aviso do gateway:** o webhook da FlevoPay já traz cliente, endereço, UTMs e valor. Quando ele chega, o
   servidor confirma o status na API dela, monta o pedido com esses dados e envia `Purchase` ao TikTok e `paid` à UTMify.
   O `createdAt` da UTMify é lido da própria referência do pedido (ela leva a hora de criação), então é o mesmo na criação
   e no pagamento. Opcional (`WEBHOOK_CONTEXT=on`): o contexto do navegador (`ttclid`, `_ttp`, IP, user-agent) vai
   criptografado (AES-256-GCM) dentro da URL do webhook; desligado por padrão porque deixa a URL com ~950 caracteres.

O que protege tudo é a variável `STATE_SECRET`.

## Rotas da API

| Rota | Função |
|---|---|
| `GET /api/shop/catalog` | kits, preços (em centavos) e ID do pixel TikTok |
| `POST /api/shop/event` | recebe ViewContent / AddToCart / InitiateCheckout e envia ao TikTok Events API |
| `POST /api/shop/create` | valida, recalcula o total no servidor, gera o PIX e avisa a UTMify (`waiting_payment`) |
| `POST /api/shop/status/live` | a tela do PIX consulta a cada 1 s; exige o `id` do pedido + a chave do navegador |
| `POST /api/shop/webhook` | aviso do gateway; confirma o status na API do gateway antes de aceitar |
| `GET /api/shop/health` | responde `ok` quando o servidor está configurado (`STATE_SECRET` válido) |

Se o TikTok ou a UTMify falharem ao registrar um pagamento, o webhook responde erro e o gateway tenta de novo.
Repetições são inofensivas: o TikTok deduplica por `event_id` (48 h) e a UTMify atualiza pelo id do pedido.

## Scripts de tracking no HTML

Todos os 11 `index.html` (raiz e uma pasta por rota) são cópias idênticas e carregam dois scripts inline no `<head>`:
o pixel do TikTok e o pixel do TikTok da UTMify. Como o CSP do `vercel.json` só aceita script inline com hash,
**se alterar qualquer um desses scripts, recalcule o hash SHA-256 e troque em `script-src`**. Sem isso o navegador bloqueia
o script em silêncio. Depois de editar o `index.html` da raiz, copie-o para as outras pastas de rota para manterem-se iguais.

## Rodar localmente

Precisa do Node 20.12 ou superior.

```
copy .env.example .env      # ajuste: PAYMENT_GATEWAY=mock para testar sem gateway real
node dev-server.js          # http://localhost:3000
node --test                 # testes
```

Com `PAYMENT_GATEWAY=mock` o PIX gerado é falso e o estado fica na memória do processo (por isso o mock só roda
no seu computador). Para simular o pagamento: `POST /api/shop/dev/mock-pay` com `{"id":"<id do pedido>"}`.
Sem `STATE_SECRET`, o servidor local gera um temporário a cada início.

## Publicar na Vercel (projeto novo)

1. Suba esta pasta para um repositório **privado** e importe na Vercel. Framework: Other.
2. Em Settings > Environment Variables cadastre as variáveis de `.env.example`. Obrigatórias: `STATE_SECRET`,
   `FLEVOPAY_API_KEY`; para tracking, `TIKTOK_PIXEL_ID`, `TIKTOK_ACCESS_TOKEN` e `UTMIFY_API_TOKEN`.
3. Faça o deploy e abra `https://SEU-PROJETO.vercel.app/api/shop/health`: deve responder `ok`.
4. O webhook não precisa ser configurado no portal da FlevoPay: o servidor envia a URL correta em cada cobrança.
5. Teste o envio ao TikTok com `TIKTOK_TEST_EVENT_CODE` (aba *Test events* do Events Manager).

Teste no domínio de **produção** do projeto. Deploys de *preview* costumam ficar atrás da proteção de login da Vercel,
e aí o gateway não consegue chamar o webhook.

## FlevoPay: como está integrada (`server/gateways/flevopay.js`)

- Cria a cobrança em `POST /api/v1/transaction` com `source: "api_externa"` (sem `productHash`), enviando cliente, endereço,
  UTMs (`tracking`) e a `postback_url` **daquela cobrança**. Por isso **não é preciso configurar webhook no portal**:
  a FlevoPay usa a URL da própria transação. O `WEBHOOK_TOKEN` é opcional e vem desligado (vazio).
- O identificador do pedido é a nossa `reference` (única por tentativa). O status vem de
  `GET /api/v1/query?action=list_transactions&external_id=<reference>`.
- Status: `approved` = pago; `pending`, `processing` e `under_review` = pendente; `failed` = cancelado/expirado;
  `refunded` e `chargeback` como o nome diz.
- A documentação não prevê assinatura de webhook. A proteção é a confirmação do status na API da FlevoPay: o corpo do
  aviso, sozinho, nunca marca ninguém como pago, e valor pago diferente do pedido é recusado. Quem descobrir a URL do
  webhook só consegue fazer o servidor consultar a FlevoPay à toa. Se quiser uma camada extra, defina `WEBHOOK_TOKEN`
  (a URL de cada cobrança passa a levar `?token=`); sem ele nada muda.
- A consulta de status não documenta devolver o código copia-e-cola, então ele viaja dentro do `id` do pedido.
- O tracking do `Purchase` sai com os dados do próprio aviso (cliente, endereço e UTMs), sem `ttclid`, IP e user-agent,
  a menos que `WEBHOOK_CONTEXT=on`. A tela do PIX já chama `identify` do TikTok com e-mail e telefone do comprador, o que
  liga o navegador à venda pelo cadastro hasheado.
- A requisição de criação é enxuta de propósito (só `X-API-Key` e `Content-Type`, `postback_url` curta com o host da própria
  requisição, descrição sem travessão), no mesmo formato de uma integração da FlevoPay que já roda em produção.
- Se a FlevoPay criar mais de uma transação por pedido (cada pedido deve gerar uma só), veja `[loja] PIX gerado` nos logs.
- O endereço de entrega fica na FlevoPay (é enviado na cobrança e devolvido no webhook).

### Primeiro teste de verdade (faça antes de rodar anúncios)

1. Faça uma compra real de valor baixo pelo site publicado e pague o PIX.
2. Confira: a tela vai para `/obrigado`; a venda aparece na FlevoPay, na UTMify (uma vez só, veja abaixo) e no TikTok
   (*Test events*, com `TIKTOK_TEST_EVENT_CODE`).
3. Na tela do PIX, confira se o horário de "válido até" bate com o relógio (o servidor lê `expires_at` como horário de Brasília).
4. Nos *Runtime Logs* da Vercel, procure avisos `[loja]`. "usando os dados do próprio webhook" indica que a URL do
   webhook está chegando cortada.

### Atenção: UTMify duplicada

A FlevoPay diz aceitar o objeto `tracking` "para integração com a Utmify". Se o portal dela tiver a integração com a UTMify
ligada, cada venda será registrada duas vezes (pela FlevoPay e por este servidor, com ids diferentes). Use só uma:
desligue no portal ou deixe `UTMIFY_API_TOKEN` vazio aqui.

## Pendente

- O painel `/admin` do site antigo chama ~40 rotas `admin/*` que este backend não implementa; ele não funciona.

## Limitações de não ter banco

- **Não há lista de pedidos.** Quem comprou, quanto, o status e o endereço de entrega você vê no painel da FlevoPay
  (o endereço é enviado na cobrança). Confirme no primeiro teste que ele aparece por lá; se não aparecer, será preciso um
  destino para os pedidos pagos (e-mail, Telegram ou o armazenamento próprio da Vercel).
- **Reenvio do mesmo pedido pode gerar um segundo PIX** (o site desativa o botão durante o envio, e só um PIX é mostrado).
- **Trocar `STATE_SECRET`** invalida tickets e contextos de PIX ainda pendentes.
- A tela do PIX consulta o gateway a cada segundo por cliente (com cache de 3 s); confira o limite de requisições da API do gateway.
- O limite de criação de PIX (30 por IP a cada 10 min) vale por instância; para um limite global use o Firewall da Vercel.
- O plano gratuito (Hobby) da Vercel não permite uso comercial; uma loja em produção precisa do plano Pro.
