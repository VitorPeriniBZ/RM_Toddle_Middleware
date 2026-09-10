import { configVersion, configVersionDetalhe, env, logger, tenantConfig } from '@rm-toddle/config';
import {
  abrirRun,
  carregarProveniencia,
  chaveDoMapa,
  contarProveniencia,
  estaAprovado,
  fecharRun,
  idMappingRepository,
  pedirAprovacao,
  pgPool,
  registrarEscrita,
  registrarPendencia,
  resumoPendencias,
  type VereditoPendente,
} from '@rm-toddle/db';
import { toddleClient, wsDataServerClient } from '@rm-toddle/integrations';
import {
  achataAvaliacoes,
  avaliarVolume,
  decidirEscrita,
  hashValor,
  montaLotesNotasAvaliacao,
  montaXmlProva,
  projetaLoteAvaliacoes,
  resumirDecisoes,
  RmAssessmentTargets,
  RmGradeTargets,
  type ContextoProjecaoAvaliacao,
  type Decisao,
  type JanelaToddle,
  type NotaParaEscrever,
  type ProjetadoAvaliacao,
} from '@rm-toddle/domain';

const cfg = tenantConfig;

/**
 * ESCREVE a nota de AVALIAÇÃO do Toddle no TOTVS RM.
 *
 *   npm run escrever:avaliacoes
 *   npm run escrever:avaliacoes -- --turma 1266 --data-ref 2026-08-15
 *   npm run escrever:avaliacoes -- ... --executar
 *
 * ─── POR QUE ESTE SCRIPT EXISTE, E O `escrever:notas` NÃO SERVE ─────────────
 *
 * `escrever:notas` escreve na nota da ETAPA, e o `EduNotaEtapaData` DESCARTA o
 * valor — medido em 09/09/2026, seis formatos, todos com `ok=true` e releitura
 * `0.0000`. A nota da etapa é calculada por fórmula (`CODFORMULANOTA='01_ETAPA'`).
 *
 * A nota que se pode escrever é a da AVALIAÇÃO, e ela precisa de DOIS destinos:
 * `SProvas` (a avaliação) e `SNotas` (a nota dela). É isso que este script faz.
 *
 * ─── ELE CRIA ESTRUTURA, E ISSO É DIFERENTE DE ESCREVER VALOR ───────────────
 *
 * Quando o assignment do Toddle não tem prova correspondente no RM, este script
 * CRIA a prova. Escrever nota errada se corrige; criar avaliação a mais numa
 * turma polui a tela do professor e o boletim. Por isso as provas a criar saem
 * listadas em separado no relatório, e o default é ensaio.
 *
 * Antes de criar, ele procura por DESCRIÇÃO: se alguém já criou uma prova com o
 * mesmo título, adotamos a dela em vez de pôr uma segunda ao lado.
 *
 * ─── O QUE ELE NÃO FAZ ─────────────────────────────────────────────────────
 *
 * Não fecha a etapa. Escrever `SNotas` NÃO recalcula `SNOTAETAPA` — medido,
 * inclusive tocando o `SNotaEtapa` depois e esperando. Fechar o boletim é
 * processo do RM e ato humano.
 *
 * ─── ORQUESTRAÇÃO MORA AQUI, DE PROPÓSITO ──────────────────────────────────
 *
 * Sem serviço extraído: não existe segundo consumidor (este caminho NÃO está
 * agendado). Quando existir, extrair — foi o que se fez com `sincronizarNotas`
 * quando o job de nota de etapa apareceu.
 */

interface Args {
  turma?: string;
  dataRef?: string;
  executar: boolean;
  quem?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const pega = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dataRef = pega('data-ref');
  if (dataRef !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(dataRef)) {
    throw new Error(`--data-ref inválida: ${dataRef}. Use YYYY-MM-DD.`);
  }
  return {
    turma: pega('turma'),
    dataRef,
    executar: argv.includes('--executar'),
    quem: pega('quem'),
  };
}

function campusUnico(): string {
  const campi = cfg.rm.escopo.filiais.split(',').map((c) => c.trim()).filter(Boolean);
  if (cfg.rm.escopo.filiais.toUpperCase() === 'ALL' || campi.length !== 1) {
    throw new Error(
      `RM_CODFILIAL="${cfg.rm.escopo.filiais}" não serve para escrita: o contexto do ` +
        'wsDataServer exige UM CODFILIAL. Rode um campus por vez.',
    );
  }
  return campi[0];
}

const p = (s = ''): void => {
  // eslint-disable-next-line no-console
  console.log(s);
};

async function main(): Promise<void> {
  const args = parseArgs();
  const codFilial = campusUnico();
  const versao = configVersion();
  const dataRef = args.dataRef ?? new Date().toISOString().slice(0, 10);
  const chaveRun = `aval:${cfg.slug}:${codFilial}:${args.turma ?? 'todas'}:${dataRef}`;

  logger.info(
    { ...configVersionDetalhe(), codFilial, chaveRun, dataRef, executar: args.executar },
    args.executar ? 'ESCRITA de nota de avaliação no RM' : 'Ensaio (nada será enviado)',
  );

  await toddleClient.assertTargetOrganization();

  // ─── de-para, só ATIVOS ───────────────────────────────────────────────────
  const cursos = await idMappingRepository.listByType('COURSE', 'active');
  const alunos = await idMappingRepository.listByType('STUDENT', 'active');
  const etapasMap = await idMappingRepository.listByType('GRADING_PERIOD', 'active');
  const avaliacoesMap = await idMappingRepository.listByType('ASSESSMENT', 'active');

  const cursoParaTurmaDisc = new Map(cursos.map((m) => [m.toddleId, m.rmCode]));
  const alunoParaRa = new Map(alunos.map((m) => [m.toddleId, m.rmCode]));
  const periodoParaEtapa = new Map(etapasMap.map((m) => [m.toddleId, m.rmCode]));
  const avaliacaoMapeada = new Map(avaliacoesMap.map((m) => [m.toddleId, m.rmCode]));

  let turmasEmEscopo = cursos.map((m) => m.rmCode);
  let cursosFiltrados = cursos;
  if (args.turma) {
    if (!turmasEmEscopo.includes(args.turma)) {
      throw new Error(`--turma ${args.turma} não tem de-para COURSE ativo.`);
    }
    turmasEmEscopo = [args.turma];
    cursosFiltrados = cursos.filter((m) => m.rmCode === args.turma);
    cursoParaTurmaDisc.clear();
    for (const m of cursosFiltrados) cursoParaTurmaDisc.set(m.toddleId, m.rmCode);
  }

  // ─── alvos no RM ──────────────────────────────────────────────────────────
  const etapas = await RmGradeTargets.carregar(turmasEmEscopo, codFilial);
  const alvos = await RmAssessmentTargets.carregar(turmasEmEscopo, codFilial);

  // ─── currículo, ano e janelas ─────────────────────────────────────────────
  const nossos = new Set(cursosFiltrados.map((c) => c.toddleId));
  const classes = (await toddleClient.listClasses()).filter((c) => nossos.has(String(c.id)));
  const curriculos = [...new Set(classes.map((c) => String(c.curriculumId ?? '')).filter(Boolean))];
  if (curriculos.length === 0) throw new Error('Nenhuma turma mapeada tem curriculumId no Toddle.');

  const anos = await toddleClient.listAcademicYears();
  const academicYearId = String(anos.find((a) => a.isCurrent === true)?.id ?? '');

  const janelaDoPeriodo = new Map<string, JanelaToddle>();
  for (const c of curriculos) {
    for (const gp of await toddleClient.listGradingPeriods(c)) {
      if (gp.startDate && gp.endDate) {
        janelaDoPeriodo.set(String(gp.id), {
          inicio: String(gp.startDate).slice(0, 10),
          fim: String(gp.endDate).slice(0, 10),
        });
      }
    }
  }

  // ─── 1. PROJEÇÃO ──────────────────────────────────────────────────────────
  //
  // O filtro por `classIds` é o que mantém isto barato: sem ele a leitura traz
  // os 223 assignments do sandbox, 222 deles de turmas de demonstração.
  const idsDasNossas = classes.map((c) => String(c.id));
  const assignments = await toddleClient.listAssignments({
    curriculumProgramId: curriculos[0],
    academicYearId: academicYearId || undefined,
    classIds: idsDasNossas,
    maxRecords: 5_000,
  });
  const resultados = assignments.length
    ? await toddleClient.listStudentAssignments({
        curriculumProgramId: curriculos[0],
        assignmentIds: assignments.map((a) => String(a.id)),
        maxRecords: 20_000,
      })
    : [];

  const origem = achataAvaliacoes(assignments, resultados);

  const ctx: ContextoProjecaoAvaliacao = {
    codColigada: String(cfg.rm.escopo.coligada),
    alunoParaRa,
    cursoParaTurmaDisc,
    periodoParaEtapa,
    janelaDoPeriodo,
    etapasRm: etapas.etapas,
    alvos,
    avaliacaoMapeada,
    tiposElegiveis: env.NOTA_TIPOS_ELEGIVEIS.split(',').map((t) => t.trim()).filter(Boolean),
    dataReferencia: dataRef,
    exigirEtapaLiberada: env.NOTA_EXIGIR_ETAPA_LIBERADA,
  };
  const proj = projetaLoteAvaliacoes(origem.avaliacoes, origem.notas, ctx);

  // ─── 2. DECISÃO, por linha ────────────────────────────────────────────────
  //
  // Sem autoria: o ReadView de EduNotasData não expõe RECCREATEDBY. Então a
  // única evidência de que uma nota é nossa é a proveniência local, e nota que
  // exista no RM sem ela vira CONFLITO_HUMANO. É o lado certo para errar.
  const proveniencia = await carregarProveniencia('NOTA', proj.projetados.map((x) => x.chaveRm));
  const decisoes = new Map<string, Decisao>();
  for (const x of proj.projetados) {
    const noRm = alvos.notasPorChave.get(x.chaveRm);
    decisoes.set(
      x.origemId,
      decidirEscrita(
        { chaveNatural: x.chaveRm, valor: String(x.linha.nota) },
        noRm ? { valor: noRm.nota } : null,
        proveniencia.get(chaveDoMapa(x.chaveRm)) ?? null,
      ),
    );
  }
  const resumoDecisoes = resumirDecisoes([...decisoes.values()]);

  const liberados = proj.projetados.filter((x) => {
    const d = decisoes.get(x.origemId);
    return d?.veredito === 'ESCREVER_NOVO' || d?.veredito === 'ATUALIZAR_NOSSO';
  });
  const lotes = montaLotesNotasAvaliacao(liberados.map((x) => x.linha));

  // Só as provas de que alguma nota liberada precisa.
  const provasNecessarias = proj.provasACriar.filter((pr) =>
    liberados.some((x) => x.linha.idTurmaDisc === pr.idTurmaDisc && x.linha.codProva === pr.codProva),
  );

  // ─── 4. TETO DE VOLUME ────────────────────────────────────────────────────
  const jaEscritas = await contarProveniencia();
  const volume = avaliarVolume(
    { aEscrever: resumoDecisoes.aEscrever, emEscopo: proj.projetados.length, historico: jaEscritas.NOTA ?? null },
    {
      tetoAbsoluto: env.WRITE_TETO_ABSOLUTO,
      desvioMaxPct: env.WRITE_DESVIO_MAX_PCT,
      tetoEscopoPct: env.WRITE_TETO_ESCOPO_PCT,
      pisoSemAprovacao: env.WRITE_PISO_SEM_APROVACAO,
    },
  );

  // ─── relatório ────────────────────────────────────────────────────────────
  p('');
  p('══════════════════════════════════════════════════════════════════');
  p(`  NOTA DE AVALIAÇÃO  Toddle -> RM   ${args.executar ? '*** ESCRITA ***' : '(ensaio)'}`);
  p('══════════════════════════════════════════════════════════════════');
  p(`  campus         CODFILIAL=${codFilial}   escopo ${turmasEmEscopo.length} turma-disciplina`);
  p(`  tipos elegíveis ${ctx.tiposElegiveis.join(', ')}`);
  p(`  data de ref.   ${dataRef}`);
  p(`  run            ${chaveRun}`);
  p('');
  p('── o que o Toddle tem ────────────────────────────────────────────');
  p(`  avaliações (assignments)        ${origem.avaliacoes.length}`);
  for (const [t, n] of Object.entries(origem.porTipo)) p(`      ${t.padEnd(28)} ${n}`);
  p(`  resultados lidos                ${origem.resultadosLidos}`);
  p(`  com nota numérica               ${origem.notas.length}`);
  p(`  sem nota lançada                ${origem.semNota}`);
  p(`  só rubrica (sem número)         ${origem.soRubrica}`);
  p('');
  p('── o que o RM tem ────────────────────────────────────────────────');
  p(`  etapas de nota digitáveis       ${etapas.totalEtapas}`);
  p(`  avaliações já cadastradas       ${alvos.totalProvas}`);
  p(`  notas de avaliação existentes   ${alvos.totalNotas}`);
  p('');
  p('── plano ─────────────────────────────────────────────────────────');
  p(`  projetáveis                     ${proj.projetados.length}`);
  p(`  recusados na projeção           ${proj.recusados.length}`);
  for (const [m, n] of Object.entries(proj.porMotivo)) p(`      ${m.padEnd(28)} ${n}`);
  if (proj.colisoes.length) {
    p(`  COLISÃO                         ${proj.colisoes.length} chave(s) com dois valores`);
  }
  p('');
  for (const [v, n] of Object.entries(resumoDecisoes.porVeredito)) p(`      ${v.padEnd(28)} ${n}`);
  p(`  A ESCREVER                      ${resumoDecisoes.aEscrever}`);
  p(`  pendências                      ${resumoDecisoes.pendencias}`);
  p('');
  p(`  AVALIAÇÕES A CRIAR NO RM        ${provasNecessarias.length}   (isto é ESTRUTURA)`);
  for (const pr of provasNecessarias) {
    p(`      IDTURMADISC ${pr.idTurmaDisc} etapa ${pr.codEtapa} CODPROVA ${pr.codProva}  VALOR ${pr.valor}`);
    p(`         "${pr.descricao.slice(0, 70)}"`);
  }
  p('');
  p(`  datasets de nota                ${lotes.length}`);
  for (const l of lotes) {
    p(`      IDTURMADISC ${l.idTurmaDisc} etapa ${l.codEtapa} prova ${l.codProva}: ${l.linhas.length} nota(s)`);
    for (const n of l.linhas) p(`          RA ${n.ra}  nota ${n.nota}`);
  }
  p('');
  p(`  teto de volume                  ${volume.veredito}`);
  for (const m of volume.motivos) p(`      ${m}`);

  // ─── 3. PENDÊNCIAS ────────────────────────────────────────────────────────
  let pendenciasAbertas = 0;
  for (const x of proj.projetados) {
    const d = decisoes.get(x.origemId);
    if (!d?.pendencia) continue;
    const abriu = await registrarPendencia({
      entidade: 'NOTA',
      chaveNatural: x.chaveRm,
      veredito: d.veredito as VereditoPendente,
      porque:
        `${d.porque}. Nota de AVALIAÇÃO (CODPROVA ${x.linha.codProva}); o ReadView do RM não ` +
        'expõe autoria, então "existe e não é nossa" é o veredito conservador.',
      valorDesejado: String(x.linha.nota),
      valorNoRm: alvos.notasPorChave.get(x.chaveRm)?.nota ?? null,
      hashDesejado: hashValor(String(x.linha.nota)),
      origemId: x.origemId,
    });
    if (abriu) pendenciasAbertas += 1;
  }
  const fila = await resumoPendencias();
  p('');
  p(`  fila de pendências (aberta)     ${fila.abertas}   (${pendenciasAbertas} nesta passada)`);

  if (!args.executar) {
    p('');
    p('  ENSAIO. Nada foi enviado ao RM. Use --executar para escrever.');
    p('');
    await pgPool.end();
    return;
  }
  if (lotes.length === 0) {
    p('');
    p('  Nada a escrever.');
    p('');
    await pgPool.end();
    return;
  }
  if (volume.veredito === 'RECUSADO') {
    p('');
    p('  RECUSADO pelo teto de volume. Nada foi enviado — isto é para investigar.');
    p('');
    await pgPool.end();
    process.exitCode = 1;
    return;
  }
  if (volume.veredito === 'PRECISA_APROVACAO' && !(await estaAprovado(chaveRun))) {
    await pedirAprovacao({
      chave: chaveRun,
      tipo: 'avaliacao_toddle_para_rm',
      payload: {
        codFilial,
        dataRef,
        aEscrever: resumoDecisoes.aEscrever,
        provasACriar: provasNecessarias.map((pr) => ({
          idTurmaDisc: pr.idTurmaDisc, codEtapa: pr.codEtapa, codProva: pr.codProva,
          descricao: pr.descricao, valor: pr.valor,
        })),
        datasets: lotes.map((l) => ({ idTurmaDisc: l.idTurmaDisc, codProva: l.codProva, linhas: l.linhas.length })),
        motivosDoTeto: volume.motivos,
        configVersion: versao,
        propostoPor: args.quem ?? null,
      },
    });
    p('');
    p('  PRECISA APROVAÇÃO. Pedido registrado, nada enviado.');
    p(`  Aprove com: npm run aprovar -- --chave ${chaveRun} --quem SEU_NOME`);
    p('');
    await pgPool.end();
    return;
  }

  // ─── ESCRITA ──────────────────────────────────────────────────────────────
  const runId = await abrirRun({
    tipo: 'avaliacao_toddle_para_rm',
    chave: chaveRun,
    configVersion: versao,
    payload: { codFilial, dataRef, provas: provasNecessarias.length, notas: resumoDecisoes.aEscrever, operadoPor: args.quem ?? null },
  });
  const contexto = `CODCOLIGADA=${cfg.rm.escopo.coligada};CODFILIAL=${codFilial};CODTIPOCURSO=1;CODSISTEMA=${cfg.rm.conexao.sistema}`;

  // Fase A: as avaliações. Sem elas a nota não tem endereço, então uma falha
  // aqui aborta o grupo em vez de escrever nota órfã.
  p('');
  p('── fase A: criando as avaliações ─────────────────────────────────');
  const provasOk = new Set<string>();
  for (const pr of provasNecessarias) {
    const r = await wsDataServerClient.saveRecord('EduProvasData', montaXmlProva(pr), contexto);
    if (r.ok) {
      provasOk.add(`${pr.idTurmaDisc}|${pr.codEtapa}|${pr.codProva}`);
      await idMappingRepository.upsert({
        entityType: 'ASSESSMENT',
        rmCode: pr.rmCode,
        toddleId: pr.assignmentId,
      });
      p(`  OK   ${pr.rmCode}  "${pr.descricao.slice(0, 50)}"  VALOR ${pr.valor}`);
    } else {
      p(`  FALHOU ${pr.rmCode}: ${r.resposta.replace(/\s+/g, ' ').slice(0, 180)}`);
    }
  }

  // Fase B: as notas.
  p('');
  p('── fase B: escrevendo as notas ───────────────────────────────────');
  const escritas: NotaParaEscrever[] = [];
  const recusadas: Array<{ linha: NotaParaEscrever; resposta: string }> = [];
  let chamadas = 0;

  for (const l of lotes) {
    const chaveProva = `${l.idTurmaDisc}|${l.codEtapa}|${l.codProva}`;
    const precisava = provasNecessarias.some(
      (pr) => `${pr.idTurmaDisc}|${pr.codEtapa}|${pr.codProva}` === chaveProva,
    );
    if (precisava && !provasOk.has(chaveProva)) {
      p(`  PULADO ${chaveProva}: a avaliação não pôde ser criada`);
      continue;
    }
    const r = await wsDataServerClient.saveRecord('EduNotasData', l.xml, contexto);
    chamadas += 1;
    if (r.ok) {
      escritas.push(...l.linhas);
      p(`  OK   ${chaveProva}: ${l.linhas.length} nota(s)`);
    } else {
      for (const n of l.linhas) recusadas.push({ linha: n, resposta: r.resposta });
      p(`  FALHOU ${chaveProva}: ${r.resposta.replace(/\s+/g, ' ').slice(0, 180)}`);
    }
  }

  for (const x of liberados) {
    if (!escritas.some((e) => e.ra === x.linha.ra && e.codProva === x.linha.codProva)) continue;
    await registrarEscrita({
      entidade: 'NOTA',
      chaveNatural: x.chaveRm,
      payloadHash: hashValor(String(x.linha.nota)),
      runId,
    });
  }

  // ─── CONFERÊNCIA POR LEITURA ──────────────────────────────────────────────
  //
  // O SaveRecord responde HTTP 200 mesmo recusando, e o EduNotaEtapaData provou
  // que ele também aceita e DESCARTA. Aqui a releitura confere chave E valor.
  p('');
  p('── conferindo por leitura ────────────────────────────────────────');
  const depois = await RmAssessmentTargets.carregar(turmasEmEscopo, codFilial);
  let conferidas = 0;
  const divergentes: string[] = [];
  for (const x of liberados) {
    const n = depois.notasPorChave.get(x.chaveRm);
    if (n && Number(n.nota) === Number(x.linha.nota)) conferidas += 1;
    else if (escritas.some((e) => e.ra === x.linha.ra && e.codProva === x.linha.codProva)) {
      divergentes.push(`${x.chaveRm} enviado ${x.linha.nota} no RM ${n?.nota ?? '(ausente)'}`);
    }
  }
  p(`  avaliações no RM        ${alvos.totalProvas} → ${depois.totalProvas}`);
  p(`  notas de avaliação      ${alvos.totalNotas} → ${depois.totalNotas}`);
  p(`  CONFERIDAS              ${conferidas}/${liberados.length}`);
  if (divergentes.length) {
    p(`  DIVERGENTES             ${divergentes.length}`);
    for (const d of divergentes.slice(0, 10)) p(`      ${d}`);
  }
  if (recusadas.length) p(`  recusadas pelo RM       ${recusadas.length}`);

  const ok = divergentes.length === 0 && recusadas.length === 0;
  await fecharRun(runId, ok ? 'succeeded' : 'failed', {
    provasCriadas: provasOk.size,
    notasEscritas: escritas.length,
    conferidas,
    divergentes: divergentes.length,
    recusadas: recusadas.length,
    chamadas,
    pendenciasAbertas,
  });

  p('');
  await pgPool.end();
  if (!ok) process.exitCode = 1;
}

main().catch(async (err) => {
  logger.error({ err: (err as Error).message }, 'Escrita de nota de avaliação falhou');
  // eslint-disable-next-line no-console
  console.error(err);
  await pgPool.end().catch(() => undefined);
  process.exitCode = 1;
});
