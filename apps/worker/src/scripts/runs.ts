import { logger, tenantConfig } from '@rm-toddle/config';
import { contarProveniencia, pgPool, resumoPendencias, fecharRunPorChave } from '@rm-toddle/db';

/** Config da escola atendida por este processo. */
const cfg = tenantConfig;

/**
 * Responde "os jobs rodaram bem?" a partir da tabela `job_run`.
 *
 *   npm run runs                 # últimos 20
 *   npm run runs -- --limite 50
 *   npm run runs -- --tipo staff.sync
 *   npm run runs -- --so-problema
 *   npm run runs -- fechar --chave <chave> --motivo "..."   # fecha run morta
 *
 * ─── POR QUE ESTE COMANDO EXISTE ────────────────────────────────────────────
 *
 * Em 20/08/2026 eu tentei DUAS vezes responder essa pergunta e errei as duas
 * condições, porque tentei inferir saúde de efeito colateral em dado de negócio:
 * o contador do BullMQ CAI (o conjunto é podado) e o `max(updated_at)` do de-para
 * não se move num run legítimo em que nada mudou — que para professor é o caso
 * normal. O registro de run existe para tornar isso uma consulta; este comando é
 * a consulta.
 *
 * ─── O QUE OLHAR ────────────────────────────────────────────────────────────
 *
 * `executing` com `created_at` velho é a assinatura de "morreu no meio": um lote
 * esgotou as tentativas, foi para a DLQ e nunca fechou o run. Não é bug do
 * registro — é o sinal.
 *
 * `turmas_nao_mapeadas > 0` no sync de professor é o CANÁRIO DE FEVEREIRO:
 * turma-disciplina nova no RM sem turma no Toddle. Foi assim que a `1714` ficou
 * de fora com 60 faltas órfãs. Em regime normal é 0.
 */

interface Linha {
  tipo: string;
  estado: string;
  criado: Date;
  atualizado: Date;
  config_version: string | null;
  payload: Record<string, unknown> | null;
  resultado: Record<string, unknown> | null;
}

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const n = (v: unknown): number | undefined =>
  v === undefined || v === null ? undefined : Number(v);

/**
 * A fila de pendências e o total escrito no RM.
 *
 * Sai em função porque tem de aparecer TAMBÉM quando não há run registrado —
 * pendência sem run é o caso de um deploy antigo do worker convivendo com um
 * shadow rodado à mão, e é justamente aí que ninguém iria olhar.
 */
async function mostrarFila(p: (s?: string) => void): Promise<void> {
  const fila = await resumoPendencias();
  if (fila.abertas > 0) {
    p(`  ⚠ ${fila.abertas} pendência(s) de escrita ABERTA(S) — ${JSON.stringify(fila.porVeredito)}`);
    if (fila.maisAntigaDias !== undefined && fila.maisAntigaDias > 7) {
      p(`      a mais antiga está aberta há ${fila.maisAntigaDias} dias`);
    }
    p('      -> npm run pendencias');
  }
  const escrito = await contarProveniencia();
  if (Object.keys(escrito).length > 0) {
    p(`  linhas escritas no RM pela integração: ${JSON.stringify(escrito)}`);
  }
}

/**
 * Fecha à mão um run que ficou `executing` para sempre.
 *
 * ─── POR QUE ISTO PRECISA EXISTIR ───────────────────────────────────────────
 *
 * Um lote que esgota as tentativas vai para a DLQ e NUNCA fecha o run: quem
 * fecharia é o processador, e ele não roda mais. A linha fica `executing` para
 * sempre, e o painel a mostra como "presa" indefinidamente — um alarme que nunca
 * apaga, que é como se ensina um time a ignorar o painel.
 *
 * Medido em 12/09/2026: `run-repeat-students-sync-1789138800000`, aberta desde
 * 11/09 às 15:12, lote 3 na DLQ por 429 do Toddle. Um sync posterior completo
 * (255 alunos, 0 falhas) já cobriu aqueles alunos — o run está morto, só a linha
 * não sabe.
 *
 * Exige `--motivo` de propósito: fechar um run é afirmar que ele acabou, e essa
 * afirmação tem de vir com quem disse e por quê, guardada no `resultado`. Sem o
 * motivo, daqui a um mês a linha fechada não se distingue de uma que terminou
 * sozinha — e o histórico passa a mentir, que é pior que a linha presa.
 *
 * Fecha como `failed`, nunca `succeeded`: o run NÃO fez o que ia fazer.
 */
async function fechar(chave: string, motivo: string): Promise<void> {
  const { rows } = await pgPool.query<{ tipo: string; estado: string; criado: string }>(
    `SELECT o.tipo, o.estado, o.created_at AS criado
       FROM job_run o JOIN tenant t ON t.id = o.tenant_id
      WHERE t.slug = $1 AND o.chave = $2`,
    [cfg.slug, chave],
  );

  const run = rows[0];
  if (!run) {
    logger.error({ chave }, 'Run não encontrada');
    process.exitCode = 1;
    return;
  }
  // Fechar uma run que já fechou reescreveria o resultado dela — e o `resultado`
  // é a única evidência do que aquele run fez.
  if (run.estado !== 'executing') {
    logger.error({ chave, estado: run.estado }, 'Esta run já está fechada — nada a fazer');
    process.exitCode = 1;
    return;
  }

  await fecharRunPorChave(chave, 'failed', {
    fechadoManualmente: true,
    motivo,
    fechadoEm: new Date().toISOString(),
  });
  logger.warn({ chave, tipo: run.tipo, abertaDesde: run.criado, motivo }, 'Run FECHADA à mão como `failed`');
}

async function main(): Promise<void> {
  if (process.argv.includes('fechar')) {
    const chave = arg('chave');
    const motivo = arg('motivo');
    if (!chave || !motivo) {
      logger.error('Uso: npm run runs -- fechar --chave <chave> --motivo "por que ela morreu"');
      process.exitCode = 1;
    } else {
      await fechar(chave, motivo);
    }
    await pgPool.end();
    return;
  }

  const limite = Number(arg('limite') ?? 20);
  const tipo = arg('tipo');
  const soProblema = process.argv.includes('--so-problema');

  const { rows } = await pgPool.query<Linha>(
    `SELECT o.tipo, o.estado, o.created_at AS criado, o.updated_at AS atualizado,
            o.config_version, o.payload, o.resultado
       FROM job_run o
       JOIN tenant t ON t.id = o.tenant_id
      WHERE t.slug = $1
        AND ($2::text IS NULL OR o.tipo = $2)
        AND ($3::bool = false OR o.estado <> 'succeeded')
      ORDER BY o.created_at DESC
      LIMIT $4`,
    [cfg.slug, tipo ?? null, soProblema, limite],
  );

  const p = (s = ''): void => console.log(s);
  p();
  p('══════════════════════════════════════════════════════════════════════');
  p(`  Execuções — tenant ${cfg.slug}${tipo ? `, tipo ${tipo}` : ''}`);
  p('══════════════════════════════════════════════════════════════════════');

  if (rows.length === 0) {
    p();
    p('  Nenhum run registrado.');
    p();
    p('  Se os jobs estão rodando, isto significa que este deploy é ANTERIOR ao');
    p('  registro de execução — o worker precisa ser redeployado. Enquanto isso,');
    p('  "rodou bem?" só se responde lendo log de container, que morre no deploy.');
    p();
    await mostrarFila(p);
    p();
    await pgPool.end();
    return;
  }

  const marca = { succeeded: 'ok  ', failed: 'FALHA', executing: 'ABERTO' } as Record<string, string>;
  const agora = Date.now();

  for (const r of rows) {
    const res = r.resultado ?? {};
    const pay = r.payload ?? {};
    const dur = Math.round((new Date(r.atualizado).getTime() - new Date(r.criado).getTime()) / 1000);
    p();
    p(
      `  ${new Date(r.criado).toISOString().slice(0, 16).replace('T', ' ')}  ` +
        `${(marca[r.estado] ?? r.estado).padEnd(6)}  ${r.tipo.padEnd(16)}  ${dur}s  cfg=${r.config_version ?? '-'}`,
    );

    // Alunos
    const emEscopo = n(res.emEscopo) ?? n(pay.emEscopo);
    const esperados = n(pay.lotesEsperados);
    if (emEscopo !== undefined) {
      // Run abortado pela guarda nunca teve lote: mostrar `created=0 updated=0`
      // ali sugeriria que ele tentou e não conseguiu, quando ele recusou ANTES.
      const contadores =
        esperados === undefined
          ? ''
          : `  lotes=${n(res.lotesConcluidos) ?? 0}/${esperados}` +
            `  created=${n(res.created) ?? 0} updated=${n(res.updated) ?? 0} failed=${n(res.failed) ?? 0}`;
      p(`        emEscopo=${emEscopo}${contadores}`);
    }
    // Professores
    if (res.vinculados !== undefined || res.turmas_nao_mapeadas !== undefined) {
      p(
        `        criados=${n(res.criados) ?? 0} vinculados=${n(res.vinculados) ?? 0} ` +
          `semEmail=${n(res.pulados_sem_email) ?? 0} gerenciadas=${n(res.turmas_gerenciadas) ?? 0} ` +
          `naoMapeadas=${n(res.turmas_nao_mapeadas) ?? 0}`,
      );
    }
    if (res.motivo) p(`        motivo: ${String(res.motivo)}`);
    if (res.erro) p(`        erro: ${String(res.erro)}`);

    // Os dois alarmes que este comando existe para tornar visíveis.
    const naoMapeadas = n(res.turmas_nao_mapeadas) ?? 0;
    if (naoMapeadas > 0) {
      p(`        ⚠ ${naoMapeadas} turma-disciplina no RM sem turma no Toddle —`);
      p('          nota e frequência dela não têm destino. Rode reconciliar:turmas.');
    }
    const abertoHa = (agora - new Date(r.atualizado).getTime()) / 3_600_000;
    if (r.estado === 'executing' && abertoHa > 2) {
      p(`        ⚠ aberto há ${abertoHa.toFixed(1)}h — morreu no meio. Confira a DLQ.`);
    }
  }

  // Resumo: a pergunta "e agora, está bem?" tem de ter resposta na última linha.
  const ultimoOk = rows.find((r) => r.estado === 'succeeded');
  const horasDesde = ultimoOk
    ? (agora - new Date(ultimoOk.criado).getTime()) / 3_600_000
    : undefined;
  p();
  p('──────────────────────────────────────────────────────────────────────');
  if (horasDesde === undefined) {
    p('  NENHUM run bem-sucedido no histórico consultado.');
  } else {
    // 13h é o limiar recomendado para o heartbeat: o cron tem uma janela de 11h
    // entre 16:00 e 03:00, então menos que isso alerta toda madrugada.
    const alerta = horasDesde > 13 ? '  ⚠ acima do limiar de 13h' : '';
    p(`  Último sucesso há ${horasDesde.toFixed(1)}h (${ultimoOk?.tipo}).${alerta}`);
  }
  await mostrarFila(p);

  const presos = rows.filter((r) => r.estado === 'executing').length;
  const falhos = rows.filter((r) => r.estado === 'failed').length;
  const plural = (k: number, um: string, muitos: string): string => `${k} ${k === 1 ? um : muitos}`;
  p(`  Nos ${rows.length} runs listados: ${plural(falhos, 'com falha', 'com falha')}, ${plural(presos, 'aberto', 'abertos')}.`);
  p();

  await pgPool.end();
}

main().catch((err) => {
  logger.error({ err }, 'Falha ao listar execuções');
  process.exit(1);
});
