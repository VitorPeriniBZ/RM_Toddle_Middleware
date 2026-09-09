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
  achataTermGrades,
  avaliarVolume,
  chaveNaturalNota,
  decidirEscrita,
  estadoNoRmDeNota,
  fetchNotasFromRm,
  hashValor,
  indexaNotasPorChave,
  montaLotesNotas,
  projetaLoteNotas,
  resumirDecisoes,
  RmGradeTargets,
  type ContextoProjecaoNota,
  type Decisao,
  type JanelaToddle,
  type LoteNotas,
  type ProjetadoNota,
} from '@rm-toddle/domain';

/** Config da escola atendida por este processo. */
const cfg = tenantConfig;

/**
 * ESCREVE a nota de etapa do Toddle no TOTVS RM. A via de volta da NOTA.
 *
 *   npm run escrever:notas
 *   npm run escrever:notas -- --turma 1266
 *   npm run escrever:notas -- --etapa 2
 *   npm run escrever:notas -- ... --executar
 *
 * ─── SEM `--executar`, NADA É ENVIADO ───────────────────────────────────────
 *
 * O default é ensaio, pelo mesmo motivo do `escreverFrequencia`: o `SaveRecord`
 * é upsert e responde HTTP 200 mesmo recusando, e este script altera a base
 * acadêmica legal de uma escola. Um default que escreve transformaria erro de
 * digitação em incidente.
 *
 * ─── OS QUATRO GUARDAS, NA MESMA ORDEM DA FREQUÊNCIA ────────────────────────
 *
 *   1. PROJEÇÃO      "o RM aceitaria esta linha?"      -> recusa vira relatório
 *                                                          (e três delas viram fila)
 *   2. DECISÃO       "escrever apaga trabalho humano?" -> 6 vereditos, por linha
 *   3. PENDÊNCIA     "quem decide o que recusamos?"    -> fila com dono
 *   4. TETO+GATE     "este VOLUME faz sentido?"        -> olha o agregado
 *
 * ─── POR QUE A NOTA É MAIS PERIGOSA QUE A FREQUÊNCIA ────────────────────────
 *
 * A frequência que este projeto escreve é AUSÊNCIA, e ausência errada é visível:
 * o aluno ou a família reclama. Nota errada num boletim fechado é invisível até
 * o conselho de classe, e existem 7.268 notas lançadas À MÃO no RM — todas com
 * autoria de professor. É por isso que a decisão de escrita (guarda 2) não é
 * opcional aqui: sem ela, um run reescreveria trabalho humano em silêncio.
 *
 * ─── E POR QUE ELA É MAIS VERIFICÁVEL ──────────────────────────────────────
 *
 * `SNOTAETAPA` guarda a nota como LINHA. Diferente do 'P' da frequência (que é a
 * ausência de registro e por isso inverificável), toda nota escrita tem de ser
 * encontrada na releitura, com o valor certo. A conferência no fim deste script
 * é uma prova, não uma estimativa.
 */

/** Teto de alunos que o GET /term-grades pode devolver antes de abortar. */
const TETO_ALUNOS = 5_000;

/**
 * O critério que pedimos ao Toddle.
 *
 * `FINAL_SCORE` é a nota geral da etapa, a única que casa com o `NOTAFALTA`
 * decimal do RM sem régua de conversão. As escalas cadastradas nesta
 * organização são alfabéticas (medido em 09/09/2026 via `GET /grade-scale`:
 * `valueType: "ALPHA"` nas duas), e a projeção recusa valor não numérico em vez
 * de inventar de → para.
 */
const CRITERIO_PADRAO = 'FINAL_SCORE';

interface Args {
  turma?: string;
  /** CODETAPA ('1'|'2'|'3'). Filtra o que vai ser lido do Toddle. */
  etapa?: string;
  criterio: string;
  /** Data de referência do teste de janela. Default: hoje. */
  dataRef: string;
  executar: boolean;
  /** Escreve mesmo com a etapa não liberada ao aluno. Precisa ser explícito. */
  ignorarLiberacao: boolean;
  quem?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const pega = (nome: string): string | undefined => {
    const i = argv.indexOf(`--${nome}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dataRef = pega('data-ref') ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataRef)) {
    throw new Error(`--data-ref inválida: ${dataRef}. Use YYYY-MM-DD.`);
  }
  const etapa = pega('etapa');
  if (etapa !== undefined && !/^[0-9]+$/.test(etapa)) {
    throw new Error(`--etapa espera o CODETAPA numérico do RM, recebeu ${JSON.stringify(etapa)}.`);
  }
  return {
    turma: pega('turma'),
    etapa,
    criterio: pega('criterio') ?? CRITERIO_PADRAO,
    dataRef,
    executar: argv.includes('--executar'),
    ignorarLiberacao: argv.includes('--ignorar-liberacao'),
    quem: pega('quem'),
  };
}

/** Um único campus: o contexto do wsDataServer exige UM CODFILIAL. */
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

interface ResultadoEnvio {
  escritas: ProjetadoNota[];
  recusadas: Array<{ linha: ProjetadoNota; resposta: string }>;
  desconhecidas: ProjetadoNota[];
  chamadas: number;
}

/**
 * Envia um conjunto de linhas e, se o RM recusar, ISOLA a(s) culpada(s) por
 * bissecção.
 *
 * Mesma mecânica e mesmo motivo do `escreverFrequencia`: o `SaveRecord` é
 * tudo-ou-nada por dataset, e uma única linha impossível (medido na frequência:
 * aluna sem vínculo com a turma-disciplina) derrubaria as outras 24. Partir ao
 * meio custa O(k·log n) para k linhas ruins, e k é tipicamente 1.
 *
 * Timeout (`desconhecido`) NÃO é partido: a escrita pode ter acontecido, e
 * dividir depois de um envio sem resposta é escrever duas vezes de olhos
 * fechados. Essas voltam marcadas e quem decide é a releitura.
 */
async function enviarComIsolamento(
  linhas: ProjetadoNota[],
  aulasDadasDe: ((td: string, etapa: string) => string | null) | undefined,
  contexto: string,
): Promise<ResultadoEnvio> {
  const vazio: ResultadoEnvio = { escritas: [], recusadas: [], desconhecidas: [], chamadas: 0 };
  if (linhas.length === 0) return vazio;

  const [lote] = montaLotesNotas(linhas, aulasDadasDe);
  if (!lote) return vazio;

  const r = await wsDataServerClient.saveRecord('EduNotaEtapaData', lote.xml, contexto);

  if (r.desconhecido) return { escritas: [], recusadas: [], desconhecidas: linhas, chamadas: 1 };
  if (r.ok) return { escritas: linhas, recusadas: [], desconhecidas: [], chamadas: 1 };
  if (linhas.length === 1) {
    return { escritas: [], recusadas: [{ linha: linhas[0], resposta: r.resposta }], desconhecidas: [], chamadas: 1 };
  }

  const meio = Math.floor(linhas.length / 2);
  const a = await enviarComIsolamento(linhas.slice(0, meio), aulasDadasDe, contexto);
  const b = await enviarComIsolamento(linhas.slice(meio), aulasDadasDe, contexto);
  return {
    escritas: [...a.escritas, ...b.escritas],
    recusadas: [...a.recusadas, ...b.recusadas],
    desconhecidas: [...a.desconhecidas, ...b.desconhecidas],
    chamadas: 1 + a.chamadas + b.chamadas,
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const codFilial = campusUnico();
  const versao = configVersion();

  const chaveRun = `nota:${cfg.slug}:${codFilial}:${args.etapa ?? 'todas'}:${args.turma ?? 'todas'}:${args.dataRef}`;

  logger.info(
    { ...configVersionDetalhe(), configVersion: versao, codFilial, chaveRun, criterio: args.criterio, dataRef: args.dataRef, executar: args.executar },
    args.executar ? 'ESCRITA de nota no RM' : 'Ensaio de escrita de nota (nada será enviado)',
  );

  await toddleClient.assertTargetOrganization();

  // ─── de-para, só ATIVOS ───────────────────────────────────────────────────
  const cursos = await idMappingRepository.listByType('COURSE', 'active');
  const alunos = await idMappingRepository.listByType('STUDENT', 'active');
  const etapas = await idMappingRepository.listByType('GRADING_PERIOD', 'active');

  const cursoParaTurmaDisc = new Map(cursos.map((m) => [m.toddleId, m.rmCode]));
  const alunoParaRa = new Map(alunos.map((m) => [m.toddleId, m.rmCode]));
  // O de-para guarda etapa (rmCode) -> gradingPeriodId (toddleId). Aqui a
  // pergunta é a inversa, e é 1:1 pelos dois lados.
  const periodoParaEtapa = new Map(etapas.map((m) => [m.toddleId, m.rmCode]));

  let turmasEmEscopo = cursos.map((m) => m.rmCode);
  let cursosFiltrados = cursos;
  if (args.turma) {
    if (!turmasEmEscopo.includes(args.turma)) {
      throw new Error(
        `--turma ${args.turma} não está entre as turmas-disciplina com mapeamento COURSE ativo.`,
      );
    }
    turmasEmEscopo = [args.turma];
    cursosFiltrados = cursos.filter((m) => m.rmCode === args.turma);
    cursoParaTurmaDisc.clear();
    for (const m of cursosFiltrados) cursoParaTurmaDisc.set(m.toddleId, m.rmCode);
  }

  // ─── alvos no RM ──────────────────────────────────────────────────────────
  const alvos = await RmGradeTargets.carregar(turmasEmEscopo, codFilial);

  // ─── currículo, ano e as janelas do Toddle ────────────────────────────────
  //
  // O `curriculumProgramId` é obrigatório no GET /term-grades. Ele vem das
  // próprias turmas mapeadas, e não de configuração: se as turmas em escopo
  // pertencerem a mais de um currículo, ler um só truncaria o resultado em
  // silêncio — por isso a leitura é por currículo, em laço.
  const nossos = new Set(cursosFiltrados.map((c) => c.toddleId));
  const classes = (await toddleClient.listClasses()).filter((c) => nossos.has(String(c.id)));
  const curriculos = [...new Set(classes.map((c) => String(c.curriculumId ?? '')).filter(Boolean))];
  if (curriculos.length === 0) {
    throw new Error(
      'Nenhuma turma mapeada tem curriculumId no Toddle. Sem currículo o GET /term-grades ' +
        'não pode ser chamado — confira o de-para COURSE e o `npm run reconciliar:turmas`.',
    );
  }

  const anos = await toddleClient.listAcademicYears();
  const academicYearId = String(anos.find((a) => a.isCurrent === true)?.id ?? '');

  const janelaDoPeriodo = new Map<string, JanelaToddle>();
  for (const curriculo of curriculos) {
    for (const gp of await toddleClient.listGradingPeriods(curriculo)) {
      if (gp.startDate && gp.endDate) {
        janelaDoPeriodo.set(String(gp.id), {
          inicio: String(gp.startDate).slice(0, 10),
          fim: String(gp.endDate).slice(0, 10),
        });
      }
    }
  }

  // ─── matrícula do Toddle, para desempatar o fan-out de courseIds ──────────
  //
  // Um teacher course pode ter várias turmas, e a nota vem com `courseIds` em
  // ARRAY. O aluno está em UMA delas. Sem este índice a projeção recusaria toda
  // nota de teacher course com mais de uma turma (`TURMA_AMBIGUA`), o que é
  // seguro mas inútil.
  //
  // ATENÇÃO: esta é a matrícula do TODDLE, não a do RM. O RM pode discordar, e
  // aí o `SaveRecord` recusa a linha — foi exatamente isso que a frequência
  // mediu em 24/08/2026 (aluna na turma mas sem vínculo com a turma-disciplina).
  // Não há Sentença de matrícula por turma-disciplina para conferir antes.
  const turmaDiscDoAluno = new Map<string, Set<string>>();
  for (const e of await toddleClient.listEnrollments()) {
    if (String(e.type ?? '') !== 'student') continue;
    if (e.isClassArchived === true || e.isUserArchived === true) continue;
    const ra = alunoParaRa.get(String(e.userId ?? ''));
    const td = cursoParaTurmaDisc.get(String(e.courseId ?? ''));
    if (!ra || !td) continue;
    const atual = turmaDiscDoAluno.get(ra);
    if (atual) atual.add(td);
    else turmaDiscDoAluno.set(ra, new Set([td]));
  }

  // ─── 1. PROJEÇÃO ──────────────────────────────────────────────────────────
  const gradingPeriodId = args.etapa
    ? etapas.find((m) => m.rmCode === args.etapa)?.toddleId
    : undefined;
  if (args.etapa && !gradingPeriodId) {
    throw new Error(`--etapa ${args.etapa} não tem de-para GRADING_PERIOD ativo.`);
  }

  const lidos = [];
  for (const curriculo of curriculos) {
    lidos.push(
      ...(await toddleClient.listTermGrades({
        curriculumProgramId: curriculo,
        academicYearId: academicYearId || undefined,
        gradingPeriodId,
        criteriaType: args.criterio,
        maxRecords: TETO_ALUNOS,
      })),
    );
  }
  const origem = achataTermGrades(lidos);

  const ctx: ContextoProjecaoNota = {
    codColigada: String(cfg.rm.escopo.coligada),
    alunoParaRa,
    cursoParaTurmaDisc,
    periodoParaEtapa,
    janelaDoPeriodo,
    etapasRm: alvos.etapas,
    turmaDiscDoAluno,
    dataReferencia: args.dataRef,
    // Escala medida na Sentença TODDLE.NOTAS: 0,0 a 7,0 em 7.268 linhas.
    faixaNota: { min: 0, max: 7 },
    exigirEtapaLiberada: !args.ignorarLiberacao,
  };
  const resumo = projetaLoteNotas(origem.notas, ctx);

  // ─── 2. DECISÃO, por linha ────────────────────────────────────────────────
  const noRm = await fetchNotasFromRm(turmasEmEscopo, alunos.map((a) => a.rmCode));
  const notasPorChave = indexaNotasPorChave(noRm.notas);
  const proveniencia = await carregarProveniencia('NOTA', resumo.projetados.map((pr) => pr.chaveRm));

  const decisoes = new Map<string, Decisao>();
  for (const pr of resumo.projetados) {
    const noRmDaChave = notasPorChave.get(pr.chaveRm);
    decisoes.set(
      pr.origemId,
      decidirEscrita(
        { chaveNatural: pr.chaveRm, valor: pr.linha.nota },
        noRmDaChave ? estadoNoRmDeNota(noRmDaChave) : null,
        proveniencia.get(chaveDoMapa(pr.chaveRm)) ?? null,
      ),
    );
  }
  const resumoDecisoes = resumirDecisoes([...decisoes.values()]);

  const liberados: ProjetadoNota[] = resumo.projetados.filter((pr) => {
    const d = decisoes.get(pr.origemId);
    return d?.veredito === 'ESCREVER_NOVO' || d?.veredito === 'ATUALIZAR_NOSSO';
  });

  // `AULASDADAS` fica OMITIDO por default — é o que o XSD permite. A capacidade
  // de ecoar está pronta em `alvos.aulasDadasDe`; ver o cabeçalho de notaXml.ts
  // para o porquê de a resposta certa só se conhecer no primeiro SaveRecord real.
  const lotes: LoteNotas[] = montaLotesNotas(liberados);

  // ─── 4. TETO DE VOLUME ────────────────────────────────────────────────────
  const jaEscritas = await contarProveniencia();
  const volume = avaliarVolume(
    {
      aEscrever: resumoDecisoes.aEscrever,
      emEscopo: resumo.projetados.length,
      historico: jaEscritas.NOTA ?? null,
    },
    {
      tetoAbsoluto: env.WRITE_TETO_ABSOLUTO,
      desvioMaxPct: env.WRITE_DESVIO_MAX_PCT,
      tetoEscopoPct: env.WRITE_TETO_ESCOPO_PCT,
      pisoSemAprovacao: env.WRITE_PISO_SEM_APROVACAO,
    },
  );

  // ─── relatório do plano ───────────────────────────────────────────────────
  p('');
  p('══════════════════════════════════════════════════════════════════');
  p(`  NOTA Toddle -> RM   ${args.executar ? '*** ESCRITA ***' : '(ensaio)'}`);
  p('══════════════════════════════════════════════════════════════════');
  p(`  campus         CODFILIAL=${codFilial}   coligada=${cfg.rm.escopo.coligada}`);
  p(`  escopo         ${turmasEmEscopo.length} turma-disciplina, ${alunos.length} alunos`);
  p(`  critério       ${args.criterio}${args.etapa ? `   etapa ${args.etapa}` : ''}`);
  p(`  data de ref.   ${args.dataRef}   (teste de janela da D2)`);
  p(`  configVersion  ${versao}`);
  p(`  run            ${chaveRun}`);
  p('');
  p('── o que o Toddle tem ────────────────────────────────────────────');
  p(`  alunos lidos                    ${origem.alunos}`);
  p(`  alunos COM nota                 ${origem.alunosComNota}`);
  p(`  notas achatadas                 ${origem.notas.length}`);
  for (const [c, n] of Object.entries(origem.porCriterio)) p(`      ${c.padEnd(28)} ${n}`);
  p('');
  p('── etapas de nota no RM ──────────────────────────────────────────');
  p(`  etapas digitáveis               ${alvos.totalEtapas}`);
  for (const v of alvos.vigencias()) p(`      ${v}`);
  if (alvos.semEtapaDeNota.length) {
    p(`  turma-disciplina SEM etapa      ${alvos.semEtapaDeNota.length}`);
  }
  p('');
  p('── plano ─────────────────────────────────────────────────────────');
  p(`  projetáveis                     ${resumo.projetados.length}`);
  p(`  recusados na projeção           ${resumo.recusados.length}`);
  for (const [motivo, n] of Object.entries(resumo.porMotivo)) p(`      ${motivo.padEnd(28)} ${n}`);
  if (resumo.colisoes.length) {
    p('');
    p(`  COLISÃO: ${resumo.colisoes.length} chave(s) com duas notas diferentes do Toddle`);
    for (const c of resumo.colisoes.slice(0, 5)) p(`      ${c}`);
    p('      Duas notas do Toddle caem no MESMO destino do RM com valores diferentes.');
    p('      Não é duplicata: é ambiguidade, e escolher uma seria chute.');
  }
  p('');
  for (const [veredito, n] of Object.entries(resumoDecisoes.porVeredito)) {
    p(`      ${veredito.padEnd(28)} ${n}`);
  }
  p(`  A ESCREVER                      ${resumoDecisoes.aEscrever}`);
  p(`  pendências (precisam de humano) ${resumoDecisoes.pendencias}`);
  p('');
  p(`  datasets                        ${lotes.length}`);
  for (const l of lotes) {
    p(`      IDTURMADISC ${l.idTurmaDisc}  etapa ${l.codEtapa}  ${l.linhas.length} nota(s)`);
  }
  if (lotes.length === 1 && lotes[0].linhas.length <= 3) {
    p('');
    p('── XML que seria enviado ─────────────────────────────────────────');
    for (const linha of lotes[0].xml.split('\n')) p(`  ${linha}`);
  }
  p('');
  p(`  teto de volume                  ${volume.veredito}`);
  for (const m of volume.motivos) p(`      ${m}`);

  // ─── 3. PENDÊNCIAS ────────────────────────────────────────────────────────
  //
  // Registradas mesmo em ensaio: anotar no NOSSO banco que alguém precisa olhar
  // não muda dado de ninguém, e a fila só tem valor se encher antes da escrita.
  let pendenciasAbertas = 0;
  for (const pr of resumo.projetados) {
    const d = decisoes.get(pr.origemId);
    if (!d?.pendencia) continue;
    const abriu = await registrarPendencia({
      entidade: 'NOTA',
      chaveNatural: pr.chaveRm,
      veredito: d.veredito as VereditoPendente,
      porque: d.porque,
      valorDesejado: pr.linha.nota,
      valorNoRm: notasPorChave.get(pr.chaveRm)?.nota ?? null,
      hashDesejado: hashValor(pr.linha.nota),
      origemId: pr.origemId,
    });
    if (abriu) pendenciasAbertas += 1;
  }

  // ─── 3b. AS TRÊS RECUSAS QUE SÃO DECISÃO DE GENTE -> fila ─────────────────
  //
  // Ver a migration 014. Uma linha por PERGUNTA, não por nota: a pergunta não
  // muda de aluno para aluno, e uma pendência por registro faria a fila repetir
  // centenas de vezes a mesma coisa.
  const agrupadas = new Map<
    string,
    { veredito: VereditoPendente; porque: string; n: number; exemplo: string }
  >();
  for (const r of resumo.recusados) {
    let chave: string | null = null;
    let veredito: VereditoPendente | null = null;
    let porque = '';

    if (r.motivo === 'JANELA_INCOMPATIVEL') {
      const td = r.origem.courseIds.map((c) => ctx.cursoParaTurmaDisc.get(c)).find(Boolean) ?? '?';
      const etapa = ctx.periodoParaEtapa.get(r.origem.gradingPeriodId) ?? '?';
      chave = `JANELA:${td}:${etapa}`;
      veredito = 'JANELA_INCOMPATIVEL';
      porque =
        `O de-para de etapa é por ORDINAL e as janelas do Toddle e do RM divergem: ${r.detalhe}. ` +
        'Enquanto isso não for corrigido, a nota desta faixa NÃO chega ao RM. Resolver aqui é ' +
        'corrigir as datas dos grading periods no portal do Toddle (D2 em docs/DECISOES.md) — ' +
        'e o ano corrente não é editável, então a correção real é no ano letivo novo.';
    } else if (r.motivo === 'VALOR_NAO_NUMERICO') {
      chave = `ESCALA:${r.origem.valorCru}`;
      veredito = 'VALOR_NAO_NUMERICO';
      porque =
        `O Toddle devolveu a nota "${r.origem.valorCru}" (critério ${r.origem.criterio ?? '?'}) e o RM ` +
        'guarda NOTAFALTA decimal. As escalas cadastradas no Toddle são alfabéticas e a tabela de ' +
        'conceito do RM está vazia: não existe régua oficial de letra para número. Resolver aqui é ' +
        'a escola DEFINIR a conversão — não lançar a nota à mão.';
    } else if (r.motivo === 'ETAPA_NAO_LIBERADA') {
      const etapa = ctx.periodoParaEtapa.get(r.origem.gradingPeriodId) ?? '?';
      chave = `ETAPA_TRAVADA:${etapa}`;
      veredito = 'ETAPA_NAO_LIBERADA';
      porque =
        `A etapa ${etapa} está com DISPONIVELALUNOS='N' no RM. Escrever publicaria nota provisória ` +
        'para a família. Medido: a flag vem "N" em 100% das notas, e ninguém sabe se ela é ' +
        'gerenciada nesta escola ou se nunca é tocada. Resolver aqui é a escola RESPONDER isso.';
    }

    if (!chave || !veredito) continue;
    const atual = agrupadas.get(chave);
    if (atual) atual.n += 1;
    else agrupadas.set(chave, { veredito, porque, n: 1, exemplo: r.origemId });
  }

  for (const [chave, info] of agrupadas) {
    const abriu = await registrarPendencia({
      entidade: 'NOTA',
      chaveNatural: chave,
      veredito: info.veredito,
      porque: info.porque,
      valorDesejado: null,
      valorNoRm: null,
      // Hash da PERGUNTA, não de um valor: reabrir só faz sentido se a pergunta
      // mudar, e é isso que este hash detecta.
      hashDesejado: hashValor(chave),
      origemId: info.exemplo,
    });
    if (abriu) pendenciasAbertas += 1;
  }

  const fila = await resumoPendencias();
  p('');
  p(`  fila de pendências (aberta)     ${fila.abertas}   (${pendenciasAbertas} nesta passada)`);
  for (const [chave, info] of agrupadas) p(`      ${chave.padEnd(30)} ${info.n} nota(s) presas`);

  if (!args.executar) {
    p('');
    p('  ENSAIO. Nada foi enviado ao RM. Use --executar para escrever.');
    p('');
    await pgPool.end();
    return;
  }

  if (lotes.length === 0) {
    p('');
    p('  Nada a escrever. Encerrando sem tocar o RM.');
    p('');
    await pgPool.end();
    return;
  }

  // ─── GATE DE APROVAÇÃO ────────────────────────────────────────────────────
  if (volume.veredito === 'RECUSADO') {
    p('');
    p('  RECUSADO pelo teto de volume. Nada foi enviado.');
    p('  Isto não é para ser aprovado — é para ser investigado. Confira o de-para');
    p('  e o escopo antes de rodar de novo.');
    p('');
    await pgPool.end();
    process.exitCode = 1;
    return;
  }

  if (volume.veredito === 'PRECISA_APROVACAO' && !(await estaAprovado(chaveRun))) {
    await pedirAprovacao({
      chave: chaveRun,
      tipo: 'nota_toddle_para_rm',
      payload: {
        codFilial,
        etapa: args.etapa ?? null,
        criterio: args.criterio,
        dataRef: args.dataRef,
        turmas: turmasEmEscopo.length,
        aEscrever: resumoDecisoes.aEscrever,
        datasets: lotes.map((l) => ({ idTurmaDisc: l.idTurmaDisc, codEtapa: l.codEtapa, linhas: l.linhas.length })),
        motivosDoTeto: volume.motivos,
        configVersion: versao,
        propostoPor: args.quem ?? null,
      },
    });
    p('');
    p('  PRECISA APROVAÇÃO. O pedido foi registrado e nada foi enviado.');
    p(`  Aprove com: npm run aprovar -- --chave ${chaveRun} --quem SEU_NOME`);
    p('');
    await pgPool.end();
    return;
  }

  // ─── ESCRITA ──────────────────────────────────────────────────────────────
  const runId = await abrirRun({
    tipo: 'nota_toddle_para_rm',
    chave: chaveRun,
    configVersion: versao,
    payload: {
      codFilial,
      etapa: args.etapa ?? null,
      turmas: turmasEmEscopo.length,
      datasets: lotes.length,
      aEscrever: resumoDecisoes.aEscrever,
      operadoPor: args.quem ?? null,
    },
  });

  const contexto = `CODCOLIGADA=${cfg.rm.escopo.coligada};CODFILIAL=${codFilial};CODTIPOCURSO=1;CODSISTEMA=${cfg.rm.conexao.sistema}`;

  const escritas: ProjetadoNota[] = [];
  const recusadas: Array<{ linha: ProjetadoNota; resposta: string }> = [];
  const desconhecidas: ProjetadoNota[] = [];
  let chamadas = 0;

  p('');
  p('── enviando ──────────────────────────────────────────────────────');
  for (const lote of lotes) {
    const rotulo = `IDTURMADISC ${lote.idTurmaDisc} etapa ${lote.codEtapa}`;
    const r = await enviarComIsolamento(lote.linhas, undefined, contexto);
    escritas.push(...r.escritas);
    recusadas.push(...r.recusadas);
    desconhecidas.push(...r.desconhecidas);
    chamadas += r.chamadas;

    const extra = r.chamadas > 1 ? `  (${r.chamadas} envios — houve isolamento)` : '';
    p(`  ${rotulo}: ${r.escritas.length} escrita(s), ${r.recusadas.length} recusada(s), ${r.desconhecidas.length} sem resposta${extra}`);

    // Proveniência SÓ do que o RM aceitou, e nunca antes do aceite: registrar
    // escrita que não aconteceu faria a próxima passada tratar nota de professor
    // como nossa — e aí o guarda 2 deixaria de proteger exatamente o que existe
    // para proteger.
    for (const item of r.escritas) {
      await registrarEscrita({
        entidade: 'NOTA',
        chaveNatural: item.chaveRm,
        payloadHash: hashValor(item.linha.nota),
        runId,
      });
    }
  }

  // ─── A LINHA QUE O RM RECUSOU VIRA PENDÊNCIA ──────────────────────────────
  for (const { linha, resposta } of recusadas) {
    const limpa = resposta.replace(/&#xD;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
    const abriu = await registrarPendencia({
      entidade: 'NOTA',
      chaveNatural: linha.chaveRm,
      veredito: 'RM_RECUSOU',
      porque:
        'O RM recusou ESTA nota (as demais do mesmo lote foram escritas). ' +
        `Resposta do RM: "${limpa}". A causa mais comum medida na frequência é o aluno não ter ` +
        `vínculo com a turma-disciplina no RM — estar na turma não basta. Confira a matrícula ` +
        `do RA ${linha.linha.ra} na IDTURMADISC ${linha.linha.idTurmaDisc}.`,
      valorDesejado: linha.linha.nota,
      valorNoRm: null,
      hashDesejado: hashValor(linha.linha.nota),
      origemId: linha.origemId,
      runId,
    });
    if (abriu) pendenciasAbertas += 1;
  }

  // ─── CONFERÊNCIA POR LEITURA ──────────────────────────────────────────────
  //
  // O `SaveRecord` devolve HTTP 200 mesmo em erro de negócio, então a resposta
  // dele NUNCA é prova de que gravou. A prova é reler o RM.
  //
  // Aqui a prova é completa, ao contrário da frequência: nota é LINHA, e toda
  // nota escrita tem de aparecer na releitura COM O VALOR CERTO. Conferir a
  // presença da chave não basta — o `SaveRecord` é upsert, e um valor
  // malformado poderia criar a linha com outro número.
  p('');
  p('── conferindo por leitura ────────────────────────────────────────');
  const depois = await fetchNotasFromRm(turmasEmEscopo, alunos.map((a) => a.rmCode));
  const agora = indexaNotasPorChave(depois.notas);

  const confirmadas = escritas.filter((i) => {
    const n = agora.get(i.chaveRm);
    return n !== undefined && Number(n.nota) === Number(i.linha.nota);
  });
  const divergentes = escritas.filter((i) => {
    const n = agora.get(i.chaveRm);
    return n !== undefined && Number(n.nota) !== Number(i.linha.nota);
  });
  const ausentes = escritas.filter((i) => !agora.has(i.chaveRm));

  p(`  notas na leitura        ${noRm.notas.length} → ${depois.notas.length}`);
  p(`  enviadas                ${escritas.length}   recusadas ${recusadas.length}   sem resposta ${desconhecidas.length}`);
  p(`  envios ao RM            ${chamadas}`);
  p(`  CONFERIDAS              ${confirmadas.length}/${escritas.length}   (releitura achou a chave E o valor)`);
  if (divergentes.length) {
    p(`  DIVERGENTES             ${divergentes.length}   a linha existe com OUTRO valor — investigar antes de rodar de novo`);
    for (const d of divergentes.slice(0, 10)) {
      p(`      ${d.chaveRm}  enviado ${d.linha.nota}  no RM ${agora.get(d.chaveRm)?.nota}`);
    }
  }
  if (ausentes.length) {
    p(`  AUSENTES                ${ausentes.length}   o RM disse OK e a linha não está lá`);
    for (const a of ausentes.slice(0, 10)) p(`      ${a.chaveRm}`);
  }
  if (recusadas.length) {
    p('');
    p(`  ${recusadas.length} nota(s) o RM recusou individualmente — viraram pendência.`);
    p('      `npm run pendencias` mostra a resposta do RM em cada uma.');
  }

  const ok = divergentes.length === 0 && ausentes.length === 0 && desconhecidas.length === 0;
  await fecharRun(runId, ok ? 'succeeded' : 'failed', {
    enviadas: escritas.length,
    conferidas: confirmadas.length,
    divergentes: divergentes.length,
    ausentes: ausentes.length,
    recusadas: recusadas.length,
    desconhecidas: desconhecidas.length,
    chamadas,
    pendenciasAbertas,
  });

  p('');
  await pgPool.end();
  if (!ok) process.exitCode = 1;
}

main().catch(async (err) => {
  logger.error({ err: (err as Error).message }, 'Escrita de nota falhou');
  // eslint-disable-next-line no-console
  console.error(err);
  await pgPool.end().catch(() => undefined);
  process.exitCode = 1;
});
