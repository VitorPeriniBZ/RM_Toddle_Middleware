import { configVersion, env, logger, tenantConfig } from '@rm-toddle/config';
import {
  abrirRun,
  carregarProveniencia,
  chaveDoMapa,
  contarProveniencia,
  estaAprovado,
  fecharRun,
  idMappingRepository,
  pedirAprovacao,
  registrarEscrita,
  registrarPendencia,
  resumoPendencias,
  type VereditoPendente,
} from '@rm-toddle/db';
import { toddleClient, wsDataServerClient } from '@rm-toddle/integrations';
// Import DEEP de propósito: o index de `queues` abre o Redis ao ser carregado,
// e estes serviços rodam em CLI que precisa encerrar. Ver importDoIndex.test.ts.
import { FLOW } from '@rm-toddle/queues/src/fluxos';
import {
  achataTermGrades,
  avaliarVolume,
  canonizarNota,
  decidirEscrita,
  estadoNoRmDeNota,
  fetchNotasFromRm,
  hashValor,
  indexaNotasPorChave,
  montaLotesNotas,
  projetaLoteNotas,
  resumirDecisoes,
  RmGradeTargets,
  type AvaliacaoVolume,
  type ContextoProjecaoNota,
  type Decisao,
  type JanelaToddle,
  type LoteNotas,
  type ProjetadoNota,
  type RecusadoNota,
  type ResumoProjecaoNota,
  type ResumoToddleNotas,
} from '@rm-toddle/domain';

const cfg = tenantConfig;

/**
 * A via de nota Toddle -> RM, em UM lugar.
 *
 * Este módulo existe por um motivo estrutural: DOIS chamadores precisam do mesmo
 * pipeline — o script `escreverNotas.ts` (operado à mão) e o job agendado
 * `termGrades.processor.ts`. Duas cópias divergiriam, e a que divergisse seria a
 * automática — a que ninguém lê o output.
 *
 * O que ele NÃO faz, de propósito: não fecha o `pgPool` (o worker vive depois
 * dele), não escreve no stdout e não mexe em `process.exitCode`. Devolve um
 * relatório; quem chamou decide o que fazer com ele.
 *
 * ─── OS QUATRO GUARDAS, NA ORDEM ────────────────────────────────────────────
 *
 *   1. PROJEÇÃO   "o RM aceitaria esta linha?"      -> 10 recusas possíveis
 *   2. DECISÃO    "escrever apaga trabalho humano?" -> 6 vereditos, por linha
 *   3. PENDÊNCIA  "quem decide o que recusamos?"    -> fila com dono
 *   4. TETO+GATE  "este VOLUME faz sentido?"        -> olha o agregado
 *
 * Nenhum é opcional no caminho automático. O guarda 2 é o que impede um cron de
 * meia em meia hora reescrever, em silêncio, as 7.268 notas que professores
 * lançaram à mão no RM.
 */

export interface OpcoesSincronizacaoNotas {
  /** `false` = ensaio: tudo é calculado, nada é enviado ao RM. */
  executar: boolean;
  /** Restringe a UMA turma-disciplina (IDTURMADISC). */
  turma?: string;
  /** Restringe a UMA etapa do RM ('1'|'2'|'3'). */
  etapa?: string;
  criterio?: string;
  /** Data de referência do teste de janela. Default: hoje. */
  dataRef?: string;
  /** Ver NOTA_EXIGIR_ETAPA_LIBERADA. Default: o valor do ambiente. */
  exigirEtapaLiberada?: boolean;
  /** Quem operou, gravado no pedido de aprovação. */
  quem?: string;
}

export interface RelatorioNotas {
  chaveRun: string;
  codFilial: string;
  configVersion: string;
  dataRef: string;
  criterio: string;
  turmasEmEscopo: number;
  alunosEmEscopo: number;
  origem: ResumoToddleNotas;
  alvos: { etapasDigitaveis: number; vigencias: string[]; semEtapaDeNota: number };
  projecao: ResumoProjecaoNota;
  decisoes: { porVeredito: Record<string, number>; aEscrever: number; pendencias: number };
  lotes: LoteNotas[];
  volume: AvaliacaoVolume;
  pendenciasAbertasNestaPassada: number;
  filaAberta: number;
  perguntasEmAberto: Array<{ chave: string; notas: number }>;
  /** Preenchido só quando `executar` e o gate liberou. */
  escrita?: {
    enviadas: number;
    conferidas: number;
    divergentes: Array<{ chave: string; enviado: string; noRm: string | undefined }>;
    ausentes: string[];
    recusadas: Array<{ chave: string; resposta: string }>;
    desconhecidas: string[];
    chamadas: number;
    notasNoRmAntes: number;
    notasNoRmDepois: number;
  };
  /** Por que não escreveu, quando não escreveu. */
  naoEscreveu?: 'ensaio' | 'nada-a-escrever' | 'recusado-pelo-teto' | 'precisa-aprovacao' | 'desligado';
}

/** Um único campus: o contexto do wsDataServer exige UM CODFILIAL. */
export function campusUnico(): string {
  const campi = cfg.rm.escopo.filiais.split(',').map((c) => c.trim()).filter(Boolean);
  if (cfg.rm.escopo.filiais.toUpperCase() === 'ALL' || campi.length !== 1) {
    throw new Error(
      `RM_CODFILIAL="${cfg.rm.escopo.filiais}" não serve para escrita: o contexto do ` +
        'wsDataServer exige UM CODFILIAL. Rode um campus por vez.',
    );
  }
  return campi[0];
}

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
 * O `SaveRecord` é tudo-ou-nada por dataset. Medido na frequência em 24/08/2026:
 * de 25 linhas de uma aula, UMA aluna não tinha vínculo com a turma-disciplina
 * no RM e o RM recusou as 25. Partir ao meio custa O(k·log n) para k linhas
 * ruins, e k é tipicamente 1.
 *
 * Timeout (`desconhecido`) NÃO é partido: a escrita pode ter acontecido, e
 * dividir depois de um envio sem resposta é escrever duas vezes de olhos
 * fechados. Essas voltam marcadas e quem decide é a releitura.
 */
async function enviarComIsolamento(
  linhas: ProjetadoNota[],
  contexto: string,
): Promise<ResultadoEnvio> {
  const vazio: ResultadoEnvio = { escritas: [], recusadas: [], desconhecidas: [], chamadas: 0 };
  if (linhas.length === 0) return vazio;

  const [lote] = montaLotesNotas(linhas);
  if (!lote) return vazio;

  const r = await wsDataServerClient.saveRecord('EduNotaEtapaData', lote.xml, contexto);

  if (r.desconhecido) return { escritas: [], recusadas: [], desconhecidas: linhas, chamadas: 1 };
  if (r.ok) return { escritas: linhas, recusadas: [], desconhecidas: [], chamadas: 1 };
  if (linhas.length === 1) {
    return { escritas: [], recusadas: [{ linha: linhas[0], resposta: r.resposta }], desconhecidas: [], chamadas: 1 };
  }

  const meio = Math.floor(linhas.length / 2);
  const a = await enviarComIsolamento(linhas.slice(0, meio), contexto);
  const b = await enviarComIsolamento(linhas.slice(meio), contexto);
  return {
    escritas: [...a.escritas, ...b.escritas],
    recusadas: [...a.recusadas, ...b.recusadas],
    desconhecidas: [...a.desconhecidas, ...b.desconhecidas],
    chamadas: 1 + a.chamadas + b.chamadas,
  };
}

/**
 * As três recusas de projeção que são DECISÃO DE GENTE viram fila, agrupadas por
 * pergunta. Ver a migration 014 para o porquê da chave sintética.
 */
function agrupaPerguntas(
  recusados: RecusadoNota[],
  ctx: ContextoProjecaoNota,
): Map<string, { veredito: VereditoPendente; porque: string; n: number; exemplo: string }> {
  const agrupadas = new Map<string, { veredito: VereditoPendente; porque: string; n: number; exemplo: string }>();

  for (const r of recusados) {
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
        `A etapa ${etapa} está com DISPONIVELALUNOS='N' no RM e NOTA_EXIGIR_ETAPA_LIBERADA está ` +
        'ligada. Resolver aqui é a escola decidir se essa flag é gerenciada — ou desligar a ' +
        'exigência, já que gravar em etapa não liberada não exibe a nota a ninguém.';
    }

    if (!chave || !veredito) continue;
    const atual = agrupadas.get(chave);
    if (atual) atual.n += 1;
    else agrupadas.set(chave, { veredito, porque, n: 1, exemplo: r.origemId });
  }

  return agrupadas;
}

/**
 * Roda a via de nota de ponta a ponta.
 *
 * Idempotente por construção: o `GET /term-grades` do Toddle NÃO tem filtro
 * `modifiedSince` (ao contrário do /attendance), então cada passada lê tudo e é
 * o guarda 2 que decide. Nota inalterada devolve `NADA_A_FAZER` e não gasta
 * chamada ao RM — é isso que faz um cron de 30 minutos ser barato em vez de
 * reescrever a base a cada meia hora.
 */
export async function sincronizarNotas(op: OpcoesSincronizacaoNotas): Promise<RelatorioNotas> {
  const codFilial = campusUnico();
  const versao = configVersion();
  const dataRef = op.dataRef ?? new Date().toISOString().slice(0, 10);
  const criterio = op.criterio ?? 'FINAL_SCORE';
  const exigirEtapaLiberada = op.exigirEtapaLiberada ?? env.NOTA_EXIGIR_ETAPA_LIBERADA;

  // A chave do run é o que liga proposta, aprovação e execução. Tem a DATA e não
  // a hora: um cron de 30 minutos com chave por passada criaria 34 pedidos de
  // aprovação por dia, e aprovação que chega em rajada é aprovação que alguém dá
  // sem ler. Com a data, é UM pedido por dia e por escopo.
  const chaveRun = `nota:${cfg.slug}:${codFilial}:${op.etapa ?? 'todas'}:${op.turma ?? 'todas'}:${dataRef}`;

  await toddleClient.assertTargetOrganization();

  // ─── de-para, só ATIVOS ───────────────────────────────────────────────────
  const cursos = await idMappingRepository.listByType('COURSE', 'active');
  const alunos = await idMappingRepository.listByType('STUDENT', 'active');
  const etapasMap = await idMappingRepository.listByType('GRADING_PERIOD', 'active');

  const cursoParaTurmaDisc = new Map(cursos.map((m) => [m.toddleId, m.rmCode]));
  const alunoParaRa = new Map(alunos.map((m) => [m.toddleId, m.rmCode]));
  const periodoParaEtapa = new Map(etapasMap.map((m) => [m.toddleId, m.rmCode]));

  let turmasEmEscopo = cursos.map((m) => m.rmCode);
  let cursosFiltrados = cursos;
  if (op.turma) {
    if (!turmasEmEscopo.includes(op.turma)) {
      throw new Error(`turma ${op.turma} não está entre as turmas-disciplina com mapeamento COURSE ativo.`);
    }
    turmasEmEscopo = [op.turma];
    cursosFiltrados = cursos.filter((m) => m.rmCode === op.turma);
    cursoParaTurmaDisc.clear();
    for (const m of cursosFiltrados) cursoParaTurmaDisc.set(m.toddleId, m.rmCode);
  }

  const alvos = await RmGradeTargets.carregar(turmasEmEscopo, codFilial);

  // ─── currículo, ano e janelas do Toddle ───────────────────────────────────
  const nossos = new Set(cursosFiltrados.map((c) => c.toddleId));
  const classes = (await toddleClient.listClasses()).filter((c) => nossos.has(String(c.id)));
  const curriculos = [...new Set(classes.map((c) => String(c.curriculumId ?? '')).filter(Boolean))];
  if (curriculos.length === 0) {
    throw new Error(
      'Nenhuma turma mapeada tem curriculumId no Toddle. Sem currículo o GET /term-grades não ' +
        'pode ser chamado — confira o de-para COURSE e `npm run reconciliar:turmas`.',
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
  const gradingPeriodId = op.etapa ? etapasMap.find((m) => m.rmCode === op.etapa)?.toddleId : undefined;
  if (op.etapa && !gradingPeriodId) {
    throw new Error(`etapa ${op.etapa} não tem de-para GRADING_PERIOD ativo.`);
  }

  const lidos = [];
  for (const curriculo of curriculos) {
    lidos.push(
      ...(await toddleClient.listTermGrades({
        curriculumProgramId: curriculo,
        academicYearId: academicYearId || undefined,
        gradingPeriodId,
        criteriaType: criterio,
        maxRecords: 5_000,
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
    dataReferencia: dataRef,
    faixaNota: { min: 0, max: 7 },
    exigirEtapaLiberada,
  };
  const projecao = projetaLoteNotas(origem.notas, ctx);

  // ─── 2. DECISÃO, por linha ────────────────────────────────────────────────
  const noRm = await fetchNotasFromRm(turmasEmEscopo, alunos.map((a) => a.rmCode));
  const notasPorChave = indexaNotasPorChave(noRm.notas);
  const proveniencia = await carregarProveniencia('NOTA', projecao.projetados.map((pr) => pr.chaveRm));

  const decisoes = new Map<string, Decisao>();
  for (const pr of projecao.projetados) {
    const noRmDaChave = notasPorChave.get(pr.chaveRm);
    decisoes.set(
      pr.origemId,
      decidirEscrita(
        { chaveNatural: pr.chaveRm, valor: canonizarNota(pr.linha.nota) },
        noRmDaChave ? estadoNoRmDeNota(noRmDaChave) : null,
        proveniencia.get(chaveDoMapa(pr.chaveRm)) ?? null,
      ),
    );
  }
  const resumoDecisoes = resumirDecisoes([...decisoes.values()]);

  const liberados = projecao.projetados.filter((pr) => {
    const d = decisoes.get(pr.origemId);
    return d?.veredito === 'ESCREVER_NOVO' || d?.veredito === 'ATUALIZAR_NOSSO';
  });
  const lotes = montaLotesNotas(liberados);

  // ─── 4. TETO DE VOLUME ────────────────────────────────────────────────────
  const jaEscritas = await contarProveniencia();
  const volume = avaliarVolume(
    { aEscrever: resumoDecisoes.aEscrever, emEscopo: projecao.projetados.length, historico: jaEscritas.NOTA ?? null },
    {
      tetoAbsoluto: env.WRITE_TETO_ABSOLUTO,
      desvioMaxPct: env.WRITE_DESVIO_MAX_PCT,
      tetoEscopoPct: env.WRITE_TETO_ESCOPO_PCT,
      pisoSemAprovacao: env.WRITE_PISO_SEM_APROVACAO,
    },
  );

  // ─── 3. PENDÊNCIAS ────────────────────────────────────────────────────────
  //
  // Registradas mesmo em ensaio: anotar no NOSSO banco que alguém precisa olhar
  // não muda dado de ninguém, e a fila só tem valor se encher antes da escrita.
  let pendenciasAbertas = 0;
  for (const pr of projecao.projetados) {
    const d = decisoes.get(pr.origemId);
    if (!d?.pendencia) continue;
    const abriu = await registrarPendencia({
      entidade: 'NOTA',
      chaveNatural: pr.chaveRm,
      veredito: d.veredito as VereditoPendente,
      porque: d.porque,
      valorDesejado: canonizarNota(pr.linha.nota),
      valorNoRm: notasPorChave.get(pr.chaveRm)?.nota ?? null,
      hashDesejado: hashValor(canonizarNota(pr.linha.nota)),
      origemId: pr.origemId,
    });
    if (abriu) pendenciasAbertas += 1;
  }

  const agrupadas = agrupaPerguntas(projecao.recusados, ctx);
  for (const [chave, info] of agrupadas) {
    const abriu = await registrarPendencia({
      entidade: 'NOTA',
      chaveNatural: chave,
      veredito: info.veredito,
      porque: info.porque,
      valorDesejado: null,
      valorNoRm: null,
      hashDesejado: hashValor(chave),
      origemId: info.exemplo,
    });
    if (abriu) pendenciasAbertas += 1;
  }

  const fila = await resumoPendencias();

  const base: RelatorioNotas = {
    chaveRun,
    codFilial,
    configVersion: versao,
    dataRef,
    criterio,
    turmasEmEscopo: turmasEmEscopo.length,
    alunosEmEscopo: alunos.length,
    origem,
    alvos: {
      etapasDigitaveis: alvos.totalEtapas,
      vigencias: alvos.vigencias(),
      semEtapaDeNota: alvos.semEtapaDeNota.length,
    },
    projecao,
    decisoes: {
      porVeredito: resumoDecisoes.porVeredito,
      aEscrever: resumoDecisoes.aEscrever,
      pendencias: resumoDecisoes.pendencias,
    },
    lotes,
    volume,
    pendenciasAbertasNestaPassada: pendenciasAbertas,
    filaAberta: fila.abertas,
    perguntasEmAberto: [...agrupadas.entries()].map(([chave, i]) => ({ chave, notas: i.n })),
  };

  if (!op.executar) return { ...base, naoEscreveu: 'ensaio' };
  if (lotes.length === 0) return { ...base, naoEscreveu: 'nada-a-escrever' };

  // ─── GATE DE APROVAÇÃO ────────────────────────────────────────────────────
  //
  // RECUSADO não tem porta: nem aprovação humana libera, porque o veredito
  // significa "isto não parece com o trabalho de um dia".
  if (volume.veredito === 'RECUSADO') return { ...base, naoEscreveu: 'recusado-pelo-teto' };

  if (volume.veredito === 'PRECISA_APROVACAO' && !(await estaAprovado(chaveRun))) {
    await pedirAprovacao({
      chave: chaveRun,
      tipo: 'nota_toddle_para_rm',
      payload: {
        codFilial,
        etapa: op.etapa ?? null,
        criterio,
        dataRef,
        turmas: turmasEmEscopo.length,
        aEscrever: resumoDecisoes.aEscrever,
        datasets: lotes.map((l) => ({ idTurmaDisc: l.idTurmaDisc, codEtapa: l.codEtapa, linhas: l.linhas.length })),
        motivosDoTeto: volume.motivos,
        configVersion: versao,
        propostoPor: op.quem ?? null,
      },
    });
    return { ...base, naoEscreveu: 'precisa-aprovacao' };
  }

  // ─── ESCRITA ──────────────────────────────────────────────────────────────
  const runId = await abrirRun({
    tipo: FLOW.NOTAS,
    chave: chaveRun,
    configVersion: versao,
    payload: {
      codFilial,
      etapa: op.etapa ?? null,
      turmas: turmasEmEscopo.length,
      datasets: lotes.length,
      aEscrever: resumoDecisoes.aEscrever,
      operadoPor: op.quem ?? null,
    },
  });

  const contexto = `CODCOLIGADA=${cfg.rm.escopo.coligada};CODFILIAL=${codFilial};CODTIPOCURSO=1;CODSISTEMA=${cfg.rm.conexao.sistema}`;

  const escritas: ProjetadoNota[] = [];
  const recusadas: Array<{ linha: ProjetadoNota; resposta: string }> = [];
  const desconhecidas: ProjetadoNota[] = [];
  let chamadas = 0;

  for (const lote of lotes) {
    const r = await enviarComIsolamento(lote.linhas, contexto);
    escritas.push(...r.escritas);
    recusadas.push(...r.recusadas);
    desconhecidas.push(...r.desconhecidas);
    chamadas += r.chamadas;

    // Proveniência SÓ do que o RM aceitou, e nunca antes do aceite: registrar
    // escrita que não aconteceu faria a próxima passada tratar nota de professor
    // como nossa — e o guarda 2 deixaria de proteger o que existe para proteger.
    for (const item of r.escritas) {
      await registrarEscrita({
        entidade: 'NOTA',
        chaveNatural: item.chaveRm,
        // Canônico: a próxima passada compara com o valor RELIDO do RM, que
        // vem com 4 casas. Ver `notaCanonica`.
        payloadHash: hashValor(canonizarNota(item.linha.nota)),
        runId,
      });
    }
  }

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
  // dele NUNCA é prova de que gravou. Aqui a prova é completa, ao contrário da
  // frequência: nota é LINHA, e toda nota escrita tem de reaparecer na leitura
  // COM O VALOR CERTO. Conferir só a presença da chave não bastaria — o
  // SaveRecord é upsert, e um valor malformado criaria a linha com outro número.
  const depois = await fetchNotasFromRm(turmasEmEscopo, alunos.map((a) => a.rmCode));
  const agora = indexaNotasPorChave(depois.notas);

  const conferidas = escritas.filter((i) => {
    const n = agora.get(i.chaveRm);
    return n !== undefined && Number(n.nota) === Number(i.linha.nota);
  });
  const divergentes = escritas
    .filter((i) => {
      const n = agora.get(i.chaveRm);
      return n !== undefined && Number(n.nota) !== Number(i.linha.nota);
    })
    .map((i) => ({ chave: i.chaveRm, enviado: i.linha.nota, noRm: agora.get(i.chaveRm)?.nota }));
  const ausentes = escritas.filter((i) => !agora.has(i.chaveRm)).map((i) => i.chaveRm);

  const ok = divergentes.length === 0 && ausentes.length === 0 && desconhecidas.length === 0;
  await fecharRun(runId, ok ? 'succeeded' : 'failed', {
    enviadas: escritas.length,
    conferidas: conferidas.length,
    divergentes: divergentes.length,
    ausentes: ausentes.length,
    recusadas: recusadas.length,
    desconhecidas: desconhecidas.length,
    chamadas,
    pendenciasAbertas,
  });

  logger.info(
    {
      chaveRun,
      enviadas: escritas.length,
      conferidas: conferidas.length,
      divergentes: divergentes.length,
      ausentes: ausentes.length,
      recusadas: recusadas.length,
      chamadas,
    },
    ok ? 'Via de nota: escrita conferida' : 'Via de nota: escrita com divergência — investigar',
  );

  return {
    ...base,
    pendenciasAbertasNestaPassada: pendenciasAbertas,
    escrita: {
      enviadas: escritas.length,
      conferidas: conferidas.length,
      divergentes,
      ausentes,
      recusadas: recusadas.map((r) => ({ chave: r.linha.chaveRm, resposta: r.resposta })),
      desconhecidas: desconhecidas.map((d) => d.chaveRm),
      chamadas,
      notasNoRmAntes: noRm.notas.length,
      notasNoRmDepois: depois.notas.length,
    },
  };
}
