import { closeAllQueues, redisConnection, FLUXOS_EM_ORDEM, observarSchedulers, resumoDaDlq } from '@rm-toddle/queues';
import { listarAgenda, pgPool, ultimosRunsPorTipo, ultimoSucessoPorTipo } from '@rm-toddle/db';
import { proximosDisparos, tenantConfig } from '@rm-toddle/config';

/**
 * A agenda como ela está: DESEJADO × OBSERVADO.
 *
 *   npm run agenda
 *
 * ─── POR QUE AS DUAS COLUNAS, E NÃO UMA ─────────────────────────────────────
 *
 * "Desejado" é a tabela `flow_schedule`; "observado" é o que o Redis realmente
 * tem registrado. Elas divergem de verdade, e a divergência é a informação mais
 * valiosa aqui: se o Redis reiniciar sem persistência, o scheduler desaparece e
 * **nada dá erro** — o worker segue de pé consumindo uma fila que nunca mais
 * recebe nada, e a descoberta vem dias depois pela ausência de dado no Toddle.
 *
 * Um relatório que mostrasse só o desejado seria mais uma superfície capaz de
 * mentir. Este existe para acusar.
 *
 * É o mesmo conteúdo do painel da tela — de propósito: quando a tela estiver
 * fora do ar, a pergunta continua respondível pelo terminal.
 */

const p = (s = ''): void => console.log(s);

async function main(): Promise<void> {
  const agenda = await listarAgenda();
  const observados = await observarSchedulers();
  const porId = new Map(observados.map((o) => [o.id, o]));
  const tipos = FLUXOS_EM_ORDEM.map((f) => f.key);
  const runs = await ultimosRunsPorTipo(tipos);
  const sucessos = await ultimoSucessoPorTipo(tipos);

  p('');
  p(`  AGENDA — tenant "${tenantConfig.slug}"`);
  p('');

  for (const fluxo of FLUXOS_EM_ORDEM) {
    const linha = agenda.find((a) => a.flowKey === fluxo.key);
    const obs = porId.get(fluxo.key);
    const run = runs[fluxo.key];

    p(`  ${fluxo.rotulo}   [${fluxo.key}]`);
    if (!linha) {
      p('    desejado:  SEM LINHA no banco = DESLIGADO (e é a propriedade de segurança:');
      p('               escrita automática não pode existir por omissão)');
    } else {
      p(`    desejado:  ${linha.ativo ? 'LIGADO ' : 'desligado'}  cron "${linha.cron}"  tz ${linha.timezone}  rev ${linha.revisao}`);
    }

    if (obs) {
      p(`    observado: cron "${obs.cron}"  tz ${obs.tz}  próximo ${obs.proximoDisparoEm ?? '?'}`);
    } else {
      p('    observado: NADA registrado no Redis');
    }

    // A divergência, dita em voz alta.
    const divergencias: string[] = [];
    if (linha?.ativo && !obs) divergencias.push('ligado no banco e AUSENTE no Redis');
    if (!linha?.ativo && obs) divergencias.push('desligado no banco e PRESENTE no Redis');
    if (linha && obs && linha.cron !== obs.cron) divergencias.push('cron diferente entre banco e Redis');
    // Revisão pendente com o Redis JA conferindo não é divergência — é quase
    // sempre "nenhum worker de pé para confirmar". Ver o comentário longo em
    // apps/api/src/rotas/agenda.ts.
    const confere = Boolean(obs && linha && obs.cron === linha.cron && obs.tz === linha.timezone);
    if (linha && linha.revisaoAplicada !== linha.revisao && !confere) {
      divergencias.push(`revisão ${linha.revisao} pendente de aplicação (aplicada: ${linha.revisaoAplicada ?? 'nenhuma'})`);
    }
    if (linha?.erroAoAplicar) divergencias.push(`erro ao aplicar: ${linha.erroAoAplicar}`);
    if (divergencias.length) for (const d of divergencias) p(`    ⚠ ${d}`);

    if (linha && linha.revisaoAplicada !== linha.revisao && confere) {
      p(`    · revisão ${linha.revisao} ainda não confirmada por um worker (o Redis já confere)`);
    }

    if (linha?.ativo && !divergencias.length) {
      p(`    próximos:  ${proximosDisparos(linha.cron, 3).join('  ·  ')}`);
    }

    if (run) {
      p(`    último run: ${run.estado}  em ${run.atualizadoEm}  ${JSON.stringify(run.resultado)}`);
    } else {
      p('    último run: nenhum registrado em job_run');
    }
    p(`    último sucesso: ${sucessos[fluxo.key] ?? 'NUNCA'}  (janela do vigia: ${fluxo.janelaSemSucessoHoras}h)`);

    if (!fluxo.podeAtivar) {
      p(`    BLOQUEADO: ${fluxo.motivoDoBloqueio}`);
    }
    p('');
  }

  const orfaos = observados.filter((o) => o.desconhecido);
  if (orfaos.length) {
    p('  SCHEDULERS ÓRFÃOS (id fora do catálogo — disparando sem aparecer em configuração):');
    for (const o of orfaos) p(`    ${o.id} na fila ${o.fila}, cron "${o.cron}"`);
    p('    A próxima reconciliação remove.');
    p('');
  }

  const dlq = await resumoDaDlq(3);
  p(`  DLQ: ${dlq.total} registro(s)${dlq.total ? ' — `npm run dlq` para ver' : ''}`);
  for (const r of dlq.recentes) p(`    ${r.failedAt}  ${r.jobName}: ${r.failedReason.slice(0, 100)}`);
  p('');
}

main()
  .then(async () => {
    await closeAllQueues();
    await redisConnection.quit();
    await pgPool.end();
  })
  .catch(async (err) => {
    p('');
    p(`  Falhou: ${err instanceof Error ? err.message : String(err)}`);
    p('');
    await closeAllQueues().catch(() => undefined);
    await redisConnection.quit().catch(() => undefined);
    await pgPool.end().catch(() => undefined);
    process.exit(1);
  });
