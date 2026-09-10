import type { Job } from 'bullmq';
import { env, logger } from '@rm-toddle/config';

/**
 * Job da via de NOTA: Toddle -> TOTVS RM.
 *
 * É a PRIMEIRA e ÚNICA escrita agendada que este projeto faz no RM. Todas as
 * outras exigem alguém digitando `--executar`. Por isso ele carrega três coisas
 * que os jobs de cadastro não precisam.
 *
 * ─── 1. INTERRUPTOR ─────────────────────────────────────────────────────────
 *
 * `NOTA_SYNC_ATIVO` é checado aqui DE NOVO, mesmo com o scheduler já sendo
 * removido quando a flag cai. Cinto e suspensório de propósito: um job pode
 * estar na fila desde antes do desligamento, e um job enfileirado não sabe que
 * a escola mudou de ideia nos últimos 30 minutos.
 *
 * ─── 2. FALHA DE INTEGRIDADE NÃO É RETENTADA ────────────────────────────────
 *
 * Se a releitura achar nota divergente, ausente, ou se algum envio ficou sem
 * resposta, o job NÃO lança. Lançar faria o BullMQ retentar, e retentar uma
 * escrita que PODE ter sido aplicada é escrever duas vezes de olhos fechados —
 * exatamente o que o `SaveRecord` sem resposta já deixa ambíguo.
 *
 * O caso fica visível por três caminhos que não envolvem reenviar: o run fecha
 * como `failed` (`npm run runs`), o heartbeat vai como falha (alerta externo) e
 * o log sai em nível de erro. Erro que se resolve reenviando lança; erro que
 * exige um humano ler o RM, não.
 *
 * Exceção de verdade — RM fora do ar, Toddle recusando, rede — essa SOBE, e aí
 * o retry e a DLQ fazem sentido.
 *
 * ─── 3. O GATE DE VOLUME PODE PARAR O JOB, E ISSO É SUCESSO ─────────────────
 *
 * `PRECISA_APROVACAO` significa que o plano é grande demais para rodar sozinho —
 * tipicamente a PRIMEIRA passada, que vê todas as notas já lançadas de uma vez.
 * O job registra o pedido e termina OK: não escreveu, mas fez o que devia.
 * Alguém aprova com `npm run aprovar` e a próxima passada executa.
 */
export async function processTermGradesSync(job: Job): Promise<Record<string, unknown>> {
  if (!env.NOTA_SYNC_ATIVO) {
    logger.warn(
      { jobId: job.id },
      'Via de nota DESLIGADA (NOTA_SYNC_ATIVO=false) — job encerrado sem tocar o RM',
    );
    return { desligado: true };
  }

  // ─── PARADA DURA: ESTE JOB APONTA PARA UM DESTINO QUE NÃO ESCREVE ─────────
  //
  // Medido em 09/09/2026, depois de este job existir: o `SaveRecord` do
  // `EduNotaEtapaData` aceita o dataset, responde `ok=true` e DESCARTA o
  // `NOTAFALTA`. Seis formatos testados, todos com releitura `0.0000`. A nota da
  // etapa é calculada por fórmula (`SETAPAS.CODFORMULANOTA='01_ETAPA'`).
  //
  // Ligar `NOTA_SYNC_ATIVO` hoje não seria inócuo: o job CRIA a linha em
  // `SNOTAETAPA` com nota **zero**, silenciosamente, em cima do histórico
  // escolar. Zero é um valor plausível — ninguém notaria.
  //
  // O caminho que funciona é a nota de AVALIAÇÃO (`SProvas` + `SNotas`), em
  // `npm run escrever:avaliacoes`, provado com 5 notas reais. Este job precisa
  // ser REDIRECIONADO para lá antes de rodar; a flag por si só não basta, e é por
  // isso que a recusa é no código e não num comentário.
  //
  // Ver docs/rm-dataservers/EduNotaEtapaData.md e
  // docs/levantamento-nota-por-avaliacao.md.
  throw new Error(
    'Via de nota de ETAPA desativada por medição: o EduNotaEtapaData aceita e DESCARTA ' +
      'o valor (ok=true, releitura 0.0000), então este job criaria notas ZERO no ' +
      'histórico escolar. Use `npm run escrever:avaliacoes` (nota de AVALIAÇÃO) e ' +
      'redirecione este processador antes de ligar NOTA_SYNC_ATIVO.',
  );
}

// ─── O QUE FICOU FORA, E POR QUÊ ─────────────────────────────────────────────
//
// Este processador tinha, abaixo da guarda acima, a orquestração completa da via
// de nota de ETAPA: chamada do serviço, classificação dos vereditos que não são
// falha (`nada-a-escrever`, `precisa-aprovacao`), heartbeat e a regra de NÃO
// retentar falha de integridade. Removido de propósito, e não por limpeza:
//
//   1. O destino está provado morto, então aquele código não pode rodar.
//   2. Quando o job for redirecionado para a nota de AVALIAÇÃO, o relatório e os
//      vereditos serão outros — dois destinos (SProvas + SNotas), criação de
//      estrutura, e conferência por chave E valor. Reaproveitar a orquestração da
//      etapa seria adaptar o formato errado.
//
// O raciocínio que vale ser levado dali para lá está preservado no histórico
// (commit 90e21fb) e nos comentários do `escreverAvaliacoes.ts`: interruptor
// checado dentro do job, falha de integridade que não é retentada, e o gate de
// volume que pode parar o job com sucesso.
