// Contrato de um gateway de PIX. Para adicionar outro, crie um arquivo nesta pasta que
// devolva um objeto com:
//
//   name                 string curto e estável
//   configured           boolean; false faz o catálogo marcar o pagamento como indisponível
//   statusReturnsPixCode boolean; false = getStatus não devolve o código copia-e-cola, então o
//                        servidor embute o código no id do pedido (a tela /pix precisa dele
//                        em toda resposta de status)
//
//   createPix({ reference, amountCents, customer, address, attribution, description, postbackUrl, metadata, expiresInMinutes })
//        -> { gatewayId, pixCode, expiresAt (ms, opcional) }
//        `reference` é único por tentativa. `postbackUrl` já leva o contexto do pedido
//        criptografado em `?s=`; `metadata` é o mesmo texto, para gateways que guardam e devolvem
//        metadados. `attribution` são as UTMs/ids de campanha.
//
//   getStatus(gatewayId)
//        -> null se não existir; senão { status, pixCode?, amountCents?, paidAt? (ms), createdAt? (ms), feeCents?, metadata? }
//           status: pending | paid | expired | canceled | refused | refunded | chargeback
//
//   parseWebhook({ headers, body, raw, query })
//        -> { gatewayId, snapshot? } (ou {} se o aviso não for de transação). `snapshot` são dados do
//           pedido que o próprio aviso traz, usados só se o contexto criptografado não chegar.
//           Deve lançar HttpError(401) se houver assinatura e ela não bater.
//
// O aviso do webhook nunca é aceito só pelo que diz: o servidor confirma com getStatus().

import { createFlevoPay } from './flevopay.js';
import { createMockGateway } from './mock.js';

export function createGateway(config, fetchFn = fetch) {
  switch (config.gateway) {
    case 'flevopay':
      return createFlevoPay(config.flevopay, fetchFn);
    case 'mock':
      // O mock guarda tudo na memória do processo: só faz sentido rodando local.
      if (config.production || config.onVercel) throw new Error('O gateway "mock" só funciona no seu computador.');
      return createMockGateway();
    default:
      throw new Error(`Gateway desconhecido: ${config.gateway}`);
  }
}
