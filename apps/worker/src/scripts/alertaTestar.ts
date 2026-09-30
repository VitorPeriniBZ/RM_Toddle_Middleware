import { hostname } from 'node:os';
import {
  alertar,
  diagnosticoDoAmbiente,
  env,
  limparJanelaDeAlerta,
  logger,
  tenantConfig,
} from '@rm-toddle/config';

/**
 * PROVA QUE O CANAL DE AVISO CHEGA EM ALGUÉM.
 *
 * ─── POR QUE ISTO PRECISA EXISTIR ───────────────────────────────────────────
 *
 * Um canal de alerta configurado e um canal de alerta FUNCIONANDO são coisas
 * diferentes, e a diferença só aparece no dia em que o alerta importa — que é
 * o pior dia possível para descobri-la. A URL pode estar com um caractere a
 * menos, o webhook pode ter sido revogado no Slack, a rede de saída do
 * container pode não alcançar o host.
 *
 * Nenhuma dessas falhas produz sintoma: `alertar()` nunca lança, por desenho
 * (canal de alerta que derruba o que ele observa é pior que canal nenhum). Ela
 * devolve `false` e segue. Então a única forma de saber é MANDAR UM E OLHAR.
 *
 * ─── O QUE ESTE SCRIPT DISTINGUE, E O `alertar()` SOZINHO NÃO ───────────────
 *
 * `alertar()` devolve `false` tanto para "não há canal configurado" quanto para
 * "o canal recusou a mensagem". São problemas diferentes, com consertos
 * diferentes — um é `.env`, o outro é o Slack. Este script separa os dois antes
 * de chamar, e diz qual é.
 *
 * ─── USO ────────────────────────────────────────────────────────────────────
 *
 *   npm run alerta:testar
 *
 * Códigos de saída, porque alguém vai automatizar em cima disto:
 *
 *   0  o canal ACEITOU a mensagem (HTTP 2xx). Não é o mesmo que "alguém leu":
 *      um webhook do Slack apontando para canal arquivado responde 200. Vá
 *      conferir uma vez; depois disso, 0 é sinal confiável de que o caminho
 *      técnico está de pé.
 *   1  não há canal configurado (`ALERTA_WEBHOOK_URL` ausente ou vazia).
 *   2  há canal, e ele recusou — HTTP de erro, timeout ou rede inalcançável.
 *
 * 1 e 2 são problemas DIFERENTES: o primeiro se conserta no `.env`, o segundo
 * no Slack ou na rede. Por isso não compartilham código.
 *
 * ─── RODE DE DENTRO DE ONDE O WORKER RODA ───────────────────────────────────
 *
 * Este script prova a conectividade da máquina em que ELE rodou. Rodado no
 * laptop, atesta o laptop — e "rede de saída bloqueada" é justamente uma falha
 * que só aparece dentro do container. Para provar produção, rode lá dentro.
 *
 * ─── RODE ISTO PERIODICAMENTE, NÃO SÓ UMA VEZ ───────────────────────────────
 *
 * Um canal que não recebe nada há sete dias é indistinguível de um canal
 * quebrado. Este script é barato o suficiente para virar um agendamento semanal
 * — o teste sintético é o que transforma "está configurado" em "está vivo".
 */

/** Códigos de saída distintos: quem chama por script precisa saber o que houve. */
const SAIDA = { ok: 0, semCanal: 1, recusado: 2 } as const;

async function main(): Promise<number> {
  const cfg = tenantConfig;
  const d = diagnosticoDoAmbiente();

  console.log('');
  console.log(`  Tenant: ${cfg.slug}`);
  // De onde rodou importa: a conectividade provada é a DESTA máquina.
  console.log(`  Rodando em: ${hostname()} (${env.NODE_ENV})`);
  console.log(`  Webhook de alerta: ${d.alerta}`);
  for (const [fluxo, estado] of Object.entries(d.heartbeats)) {
    console.log(`  Heartbeat ${fluxo.padEnd(12)}: ${estado}`);
  }
  console.log('');

  // ─── 1. NÃO HÁ CANAL ──────────────────────────────────────────────────────
  if (d.alerta === 'DESLIGADO') {
    console.error('  ✗ ALERTA_WEBHOOK_URL não está definida.');
    console.error('');
    console.error('    Nenhum alerta deste sistema chega a ninguém: nem a DLQ, nem o vigia.');
    console.error('    Defina a variável com a URL de um webhook de entrada:');
    console.error('');
    console.error('      Slack    https://api.slack.com/messaging/webhooks');
    console.error('      Discord  Editar canal > Integrações > Webhooks');
    console.error('      ntfy     https://ntfy.sh/<topico> (sem cadastro)');
    console.error('');
    console.error('    O corpo enviado é { text, content }, que os três aceitam.');
    if (d.faltando.length > 1) {
      console.error(`    Também faltam: ${d.faltando.slice(1).join(', ')}`);
    }
    console.error('');
    return SAIDA.semCanal;
  }

  // ─── 2. HÁ CANAL: MANDAR DE VERDADE ───────────────────────────────────────
  //
  // A janela de supressão é por assunto e dura 10 minutos. Sem limpá-la, um
  // segundo teste dentro da janela devolveria `false` e pareceria falha de
  // canal — o script diagnosticaria um problema que ele mesmo criou.
  limparJanelaDeAlerta();

  const enviado = await alertar({
    assunto: 'Teste do canal de alerta',
    contexto: {
      origem: 'npm run alerta:testar',
      quando: new Date().toISOString(),
      significado: 'se você está lendo isto, o canal funciona. Nenhuma ação é necessária.',
    },
  });

  if (!enviado) {
    console.error('  ✗ O canal recusou a mensagem, ou a requisição falhou.');
    console.error('');
    console.error('    A URL ESTÁ definida — o problema é do outro lado. Causas comuns:');
    console.error('      • webhook revogado ou canal arquivado no Slack/Discord');
    console.error('      • URL com erro de digitação (responde 404)');
    console.error('      • rede de saída bloqueada (comum dentro de container)');
    console.error('');
    console.error(`    O motivo exato saiu no log acima, em nível warn.`);
    console.error(`    Timeout configurado: ${env.ALERTA_WEBHOOK_TIMEOUT_MS}ms.`);
    console.error('');
    return SAIDA.recusado;
  }

  console.log('  ✓ O canal aceitou a mensagem.');
  console.log('');
  console.log('    Duas ressalvas, as duas importam:');
  console.log('    1. Aceitação não é entrega. Um webhook apontando para canal');
  console.log('       arquivado responde 200 e engole a mensagem. Confira uma vez.');
  console.log(`    2. Isto provou a rede de ${hostname()}. Se o worker roda em`);
  console.log('       outro lugar (container, servidor), rode lá também.');
  console.log('');

  if (d.faltando.length > 0) {
    console.log(`  ⚠ Ainda faltam: ${d.faltando.join(', ')}`);
    console.log('    O webhook cobre falha com o processo VIVO (DLQ, vigia).');
    console.log('    Os heartbeats cobrem o processo MORTO — e esses ainda não existem.');
    console.log('');
  }

  return SAIDA.ok;
}

main()
  .then((codigo) => process.exit(codigo))
  .catch((erro) => {
    logger.error({ erro }, 'Falha ao testar o canal de alerta');
    process.exit(1);
  });
