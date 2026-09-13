import type { Job } from 'bullmq';
import { env, heartbeat, logger } from '@rm-toddle/config';
import { sincronizarAvaliacoes } from '../../services/sincronizarAvaliacoes';

/**
 * Job da via de NOTA: Toddle -> TOTVS RM.
 *
 * É a PRIMEIRA e ÚNICA escrita agendada que este projeto faz no RM. Todas as
 * outras exigem alguém digitando `--executar`. Por isso ele carrega quatro
 * coisas que os jobs de cadastro não precisam.
 *
 * ─── 0. O DESTINO É A AVALIAÇÃO, NUNCA A ETAPA ──────────────────────────────
 *
 * Este job já apontou para a nota de ETAPA (`EduNotaEtapaData`) e ficou
 * BLOQUEADO por isso. Medido em 09/09/2026, seis formatos: aquele DataServer
 * aceita o dataset, responde `ok=true` e DESCARTA o `NOTAFALTA` — a releitura
 * volta `0.0000`. Rodar teria criado nota ZERO no histórico escolar, em
 * silêncio, e zero é um valor plausível que ninguém notaria.
 *
 * A nota que se pode escrever é a da AVALIAÇÃO: `SProvas` (a avaliação) +
 * `SNotas` (a nota dela). O serviço `sincronizarAvaliacoes` é quem faz, e é o
 * MESMO código que `npm run escrever:avaliacoes` executa — o CLI e o automático
 * não podem divergir, porque o lado que divergiria em silêncio é o automático,
 * que ninguém lê.
 *
 * A etapa não é fechada por aqui. Escrever `SNotas` NÃO recalcula `SNOTAETAPA`
 * — medido. Fechar o boletim é processo do RM e ato humano.
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
 * Se a releitura achar nota divergente, ou se o RM recusar um lote, o job NÃO
 * lança. Lançar faria o BullMQ retentar, e retentar uma escrita que PODE ter
 * sido aplicada é escrever duas vezes de olhos fechados — exatamente o que o
 * `SaveRecord` sem resposta já deixa ambíguo.
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
 * `precisa-aprovacao` significa que o plano é grande demais para rodar sozinho —
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

  const r = await sincronizarAvaliacoes({
    executar: true,
    quem: `job:${job.name}`,
    // Só relata onde há denominador de verdade. Ver queues/progresso.ts.
    // O `.catch` não é zelo: sem ele, uma queda do Redis no meio do job faria o
      // erro do progresso sumir, a barra travaria na tela e quem olhasse não saberia
      // se o job morreu ou só parou de reportar.
      aoProgredir: (p) => void job.updateProgress(p).catch(() => undefined),
  });

  // ─── não escreveu: cada motivo é um desfecho legítimo ─────────────────────
  if (!r.escrita) {
    const resumo = {
      naoEscreveu: r.naoEscreveu,
      chaveRun: r.chaveRun,
      projetaveis: r.projecao.projetaveis,
      recusadosNaProjecao: r.projecao.recusados,
      porMotivo: r.projecao.porMotivo,
      filaAberta: r.filaAberta,
    };

    if (r.naoEscreveu === 'recusado-pelo-teto') {
      // O teto recusou: é um plano grande demais para ser plausível. Não lança
      // — reenviar não muda o plano, e um humano precisa olhar.
      logger.error({ ...resumo, motivos: r.volume.motivos }, 'Via de nota RECUSADA pelo teto de volume');
      void heartbeat.notas('falha', { motivo: 'recusado-pelo-teto' });
      return resumo;
    }

    if (r.naoEscreveu === 'precisa-aprovacao') {
      logger.warn({ ...resumo, motivos: r.volume.motivos }, 'Via de nota pediu APROVAÇÃO — nada enviado');
      void heartbeat.notas('sucesso', { motivo: 'precisa-aprovacao' });
      return resumo;
    }

    // `nada-a-escrever` é o caso comum e saudável: ninguém lançou nota nova, ou
    // a janela do calendário não está aberta. Sucesso, e o heartbeat confirma
    // que o job RODOU — que é a pergunta que o vigia faz.
    logger.info(resumo, 'Via de nota: nada a escrever nesta passada');
    void heartbeat.notas('sucesso', { motivo: r.naoEscreveu });
    return resumo;
  }

  // ─── escreveu ─────────────────────────────────────────────────────────────
  const e = r.escrita;
  const integro =
    e.divergentes.length === 0 && e.recusadas.length === 0 && e.provasQueFalharam.length === 0;

  const resumo = {
    chaveRun: r.chaveRun,
    provasCriadas: e.provasCriadas,
    notasEnviadas: e.notasEnviadas,
    conferidas: e.conferidas,
    divergentes: e.divergentes.length,
    recusadas: e.recusadas.length,
    provasQueFalharam: e.provasQueFalharam.length,
    chamadas: e.chamadas,
    filaAberta: r.filaAberta,
  };

  if (!integro) {
    // NÃO lança: ver o bloco 2 do cabeçalho. A escrita pode ter sido aplicada
    // em parte, e retentar cegamente é o pior desfecho possível aqui.
    logger.error(
      { ...resumo, divergentes: e.divergentes.slice(0, 10), recusadas: e.recusadas.slice(0, 10) },
      'Via de nota terminou com DIVERGÊNCIA — precisa de um humano lendo o RM, não de retry',
    );
    void heartbeat.notas('falha', resumo);
    return resumo;
  }

  logger.info(resumo, 'Via de nota concluída e conferida por releitura');
  void heartbeat.notas('sucesso', resumo);
  return resumo;
}
