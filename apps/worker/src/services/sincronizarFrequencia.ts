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
  registrarEscrita,
  registrarPendencia,
  resumoPendencias,
  type VereditoPendente,
} from '@rm-toddle/db';
import { toddleClient, wsDataServerClient } from '@rm-toddle/integrations';
import {
  avaliarVolume,
  chaveNaturalRm,
  decidirEscrita,
  estadoNoRmDeFalta,
  fetchFrequenciaFromRm,
  hashValor,
  indexaFaltasPorChave,
  montaLotes,
  PeriodTimeIndex,
  projetaLote,
  resumirDecisoes,
  RmAttendanceTargets,
  type ContextoProjecao,
  type Decisao,
  type Projetado,
} from '@rm-toddle/domain';

/** Config da escola atendida por este processo. */
const cfg = tenantConfig;

/**
 * FREQUÊNCIA: Toddle → TOTVS RM. O pipeline, sem nada de terminal.
 *
 * ─── POR QUE ISTO SAIU DO SCRIPT ────────────────────────────────────────────
 *
 * A lógica vivia dentro de `npm run escrever:frequencia`, misturada com os
 * `console.log` do relatório. Enquanto a única forma de rodar era alguém
 * digitando, isso bastava. Com uma AGENDA, passaria a existir uma segunda cópia
 * da regra — e o lado que divergiria em silêncio seria o automático, que ninguém
 * lê. É a mesma razão pela qual a via de nota virou `sincronizarAvaliacoes`: o
 * CLI e o cron executam o MESMO código, e o CLI só acrescenta a impressão.
 *
 * ─── OS QUATRO GUARDAS, NESTA ORDEM ─────────────────────────────────────────
 *
 * A ordem não é estilo, é consequência: a resposta de cada um é entrada do
 * seguinte.
 *
 *   1. PROJEÇÃO      "o RM aceitaria esta linha?"      -> recusa vira relatório
 *   2. DECISÃO       "escrever apaga trabalho humano?" -> 6 vereditos, por linha
 *   3. PENDÊNCIA     "quem decide o que recusamos?"    -> fila com dono
 *   4. TETO+GATE     "este VOLUME faz sentido?"        -> olha o agregado
 *
 * Só o 4 enxerga o conjunto. Os três primeiros são por registro, e por isso não
 * pegariam o defeito que mais assusta: um de-para corrompido em que cada linha,
 * isolada, parece perfeitamente razoável.
 *
 * ─── A JANELA DO `AULASDADAS` ───────────────────────────────────────────────
 *
 * Ler o RM e escrever no RM acontecem no MESMO run, o mais perto possível,
 * porque o `AULASDADAS` é ecoado. Se um professor mudar o número entre a leitura
 * e o `SaveRecord`, o eco reverte a alteração dele em silêncio. Não há mitigação
 * hoje — só estreitamento da janela. Ver docs/DECISOES.md.
 */

const TETO_REGISTROS = 20_000;

export interface OperacaoDeFrequencia {
  /** `YYYY-MM-DD`, inclusive. */
  de: string;
  ate: string;
  /** Uma IDTURMADISC específica. Ausente = todas as mapeadas. */
  turma?: string;
  /** `false` = ensaio: nada é enviado ao RM. O default do CLI, de propósito. */
  executar: boolean;
  /** Quem opera. Vai para o pedido de aprovação e para o run. */
  quem?: string;
  aoProgredir?: (p: { fase: string; feitos: number; total: number }) => void;
}

export interface DatasetDeFrequencia {
  idTurmaDisc: string;
  codEtapa: string;
  linhas: number;
  aulasDadas: string | null;
}

export interface RelatorioDeFrequencia {
  janela: { de: string; ate: string };
  codFilial: string;
  /** A coligada do escopo. Vai junto do campus porque as duas identificam onde. */
  coligada: string | number;
  configVersion: string;
  chaveRun: string;
  chaveDeAprovacao: string;

  turmasEmEscopo: number;
  alunosMapeados: number;

  lidosDoToddle: number;
  projetaveis: number;
  recusadosNaProjecao: number;
  porMotivo: Record<string, number>;

  porVeredito: Record<string, number>;
  aEscrever: number;
  /** Linhas que precisam de gente antes de virar escrita. */
  pendenciasDeDecisao: number;

  escreviveis: DatasetDeFrequencia[];
  semAulasDadas: DatasetDeFrequencia[];

  volume: { veredito: string; motivos: string[] };
  filaDePendencias: { abertas: number; nestaPassada: number };

  /** `true` quando chegou a enviar algo ao RM. */
  escrita: boolean;
  /** Por que não escreveu. Ausente quando escreveu. */
  naoEscreveu?: 'ensaio' | 'nada-a-escrever' | 'recusado-pelo-teto' | 'precisa-aprovacao';

  /** Só quando `escrita` é `true`. */
  envio?: {
    escritas: number;
    recusadas: number;
    desconhecidas: number;
    chamadas: number;
    faltasAntes: number;
    faltasDepois: number;
    ausenciasEsperadas: number;
    ausenciasConfirmadas: number;
    /** `'P'` não cria linha na SFREQUENCIA, então não é verificável. */
    presencasEnviadas: number;
    /** As primeiras recusas, para o relatório apontar onde olhar. */
    amostraDeRecusas: Array<{ ra: string; idTurmaDisc: string; data: string }>;
    ok: boolean;
  };
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
  escritas: Projetado[];
  recusadas: Array<{ linha: Projetado; resposta: string }>;
  desconhecidas: Projetado[];
  /** Quantos SaveRecord foram gastos. É o custo do isolamento. */
  chamadas: number;
}

/**
 * Envia um conjunto de linhas e, se o RM recusar, ISOLA a(s) culpada(s).
 *
 * O `SaveRecord` é tudo-ou-nada por dataset. Medido em 24/08/2026: das 25 linhas
 * de uma aula de Geografia, UMA aluna não tinha vínculo com a turma-disciplina no
 * RM, e o RM recusou as 25. Tratar como "o lote falhou" faria a frequência de 24
 * alunos depender de um cadastro que não é nosso.
 *
 * Bissecção, e não linha a linha: O(k·log n) para k linhas ruins, e k é
 * tipicamente 1. Com 186 turma-disciplina, a diferença é entre minutos e horas.
 *
 * Timeout (`desconhecido`) NÃO é partido: a escrita pode ter acontecido, e
 * dividir e reenviar depois de um SENT_UNKNOWN é escrever duas vezes de olhos
 * fechados. Essas linhas voltam marcadas, e quem decide é a releitura.
 */
async function enviarComIsolamento(
  linhas: Projetado[],
  aulasDadasDe: (td: string, etapa: string) => string | null,
  contexto: string,
): Promise<ResultadoEnvio> {
  const vazio: ResultadoEnvio = { escritas: [], recusadas: [], desconhecidas: [], chamadas: 0 };
  if (linhas.length === 0) return vazio;

  const [lote] = montaLotes(linhas, aulasDadasDe);
  if (!lote || lote.aulasDadas === null) return vazio;

  const r = await wsDataServerClient.saveRecord('EduFrequenciaDiariaWSData', lote.xml, contexto);

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

export async function sincronizarFrequencia(
  op: OperacaoDeFrequencia,
): Promise<RelatorioDeFrequencia> {
  const codFilial = campusUnico();
  const versao = configVersion();
  const janela = { de: op.de, ate: op.ate };
  const progresso = op.aoProgredir ?? (() => undefined);

  /*
   * DUAS chaves, porque são duas perguntas diferentes.
   *
   * A de APROVAÇÃO identifica a INTENÇÃO — "escrever esta janela, neste escopo".
   * Mesma janela e mesmo escopo = mesma chave: reexecutar reencontra a aprovação
   * já concedida em vez de empilhar pedidos.
   *
   * A do RUN identifica a EXECUÇÃO. `abrirRun` faz UPSERT pela chave; com a
   * chave da intenção, toda passada da mesma janela sobrescreveria a MESMA linha
   * de `job_run`, e o que sobraria é uma linha por janela com "duração" igual ao
   * vão entre a primeira e a última passada. Ver a guarda mecânica em
   * packages/db/src/chaveDeRunPorExecucao.test.ts.
   */
  const chaveDeAprovacao = `freq:${cfg.slug}:${codFilial}:${op.de}:${op.ate}:${op.turma ?? 'todas'}`;
  // UM instante serve ao sufixo que torna a chave única e ao `created_at` da
  // linha — `abrirRun` só acontece lá embaixo, depois de ler Toddle e RM.
  const inicio = new Date();
  const chaveRun = `${chaveDeAprovacao}:${inicio.toISOString().slice(11, 19).replace(/:/g, '')}`;

  logger.info(
    {
      ...configVersionDetalhe(),
      configVersion: versao,
      janela: `${op.de} → ${op.ate}`,
      codFilial,
      chaveRun,
      executar: op.executar,
    },
    op.executar ? 'ESCRITA de frequência no RM' : 'Ensaio de escrita (nada será enviado)',
  );

  await toddleClient.assertTargetOrganization();

  // ─── de-para, só ATIVOS ───────────────────────────────────────────────────
  const cursos = await idMappingRepository.listByType('COURSE', 'active');
  const alunos = await idMappingRepository.listByType('STUDENT', 'active');

  const cursoParaTurmaDisc = new Map(cursos.map((m) => [m.toddleId, m.rmCode]));
  const alunoParaRa = new Map(alunos.map((m) => [m.toddleId, m.rmCode]));

  let turmasEmEscopo = cursos.map((m) => m.rmCode);
  let cursosFiltrados = cursos;
  if (op.turma) {
    if (!turmasEmEscopo.includes(op.turma)) {
      throw new Error(
        `--turma ${op.turma} não está entre as turmas-disciplina com mapeamento COURSE ativo.`,
      );
    }
    turmasEmEscopo = [op.turma];
    cursosFiltrados = cursos.filter((m) => m.rmCode === op.turma);
    cursoParaTurmaDisc.clear();
    for (const m of cursosFiltrados) cursoParaTurmaDisc.set(m.toddleId, m.rmCode);
  }

  // ─── alvos no RM e horas do Toddle ────────────────────────────────────────
  progresso({ fase: 'lendo alvos no RM', feitos: 0, total: turmasEmEscopo.length });
  const alvos = await RmAttendanceTargets.carregar(turmasEmEscopo, codFilial);
  const anos = await toddleClient.listAcademicYears();
  const anosIds = anos.map((a) => String(a.id)).filter(Boolean);
  const bellSchedules = anosIds.length ? await toddleClient.listBellSchedules(anosIds) : [];
  const periodos = bellSchedules.length
    ? PeriodTimeIndex.deBellSchedules(bellSchedules)
    : PeriodTimeIndex.vazio();

  // ─── 1. PROJEÇÃO ──────────────────────────────────────────────────────────
  const registros = await toddleClient.listAttendance({
    startDate: op.de,
    endDate: op.ate,
    courseIds: cursosFiltrados.map((m) => m.toddleId),
    maxRecords: TETO_REGISTROS,
  });

  const ctx: ContextoProjecao = {
    codColigada: cfg.rm.escopo.coligada,
    cursoParaTurmaDisc,
    alunoParaRa,
    alvos,
    periodos,
  };
  const resumo = projetaLote(registros, ctx);

  // ─── 2. DECISÃO, por linha ────────────────────────────────────────────────
  const noRm = await fetchFrequenciaFromRm(janela);
  const faltasPorChave = indexaFaltasPorChave(noRm.faltas);
  const proveniencia = await carregarProveniencia(
    'FREQUENCIA',
    resumo.projetados.map((pr) => pr.chaveRm),
  );

  const decisoes = new Map<string, Decisao>();
  for (const pr of resumo.projetados) {
    const chave = chaveNaturalRm(pr.linha);
    const falta = faltasPorChave.get(chave);
    decisoes.set(
      pr.origemId,
      decidirEscrita(
        { chaveNatural: chave, valor: pr.linha.presenca },
        falta ? estadoNoRmDeFalta(falta) : null,
        proveniencia.get(chaveDoMapa(chave)) ?? null,
      ),
    );
  }
  const resumoDecisoes = resumirDecisoes([...decisoes.values()]);

  // Só o que a decisão liberou entra no XML.
  const liberados: Projetado[] = resumo.projetados.filter((pr) => {
    const d = decisoes.get(pr.origemId);
    return d?.veredito === 'ESCREVER_NOVO' || d?.veredito === 'ATUALIZAR_NOSSO';
  });

  const lotes = montaLotes(liberados, (td, etapa) => alvos.aulasDadasDe(td, etapa));
  const semAulasDadasLotes = lotes.filter((l) => l.aulasDadas === null);
  const escreviveisLotes = lotes.filter((l) => l.aulasDadas !== null);

  const comoDataset = (l: (typeof lotes)[number]): DatasetDeFrequencia => ({
    idTurmaDisc: l.idTurmaDisc,
    codEtapa: l.codEtapa,
    linhas: l.linhas.length,
    aulasDadas: l.aulasDadas,
  });

  // ─── 4. TETO DE VOLUME ────────────────────────────────────────────────────
  const jaEscritas = await contarProveniencia();
  const volume = avaliarVolume(
    {
      aEscrever: resumoDecisoes.aEscrever,
      emEscopo: resumo.projetados.length,
      historico: jaEscritas.FREQUENCIA ?? null,
    },
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
  for (const pr of resumo.projetados) {
    const d = decisoes.get(pr.origemId);
    if (!d?.pendencia) continue;
    const chave = chaveNaturalRm(pr.linha);
    const abriu = await registrarPendencia({
      entidade: 'FREQUENCIA',
      chaveNatural: chave,
      veredito: d.veredito as VereditoPendente,
      porque: d.porque,
      valorDesejado: pr.linha.presenca,
      valorNoRm: faltasPorChave.get(chave)?.presenca ?? null,
      hashDesejado: hashValor(pr.linha.presenca),
      origemId: pr.origemId,
    });
    if (abriu) pendenciasAbertas += 1;
  }

  // ─── 3b. CÓDIGO DE CHAMADA SEM POLÍTICA -> fila, agrupado por CÓDIGO ──────
  //
  // Recusa de projeção normalmente é defeito de dado e morre no relatório. Esta
  // não: "o Toddle mandou 'Leave' e o RM não sabe o que é isso" é decisão de
  // escola pendente, e enquanto ninguém decide o aluno fica SEM frequência no
  // RM, em silêncio. Ver a migration 012.
  const porOpcao = new Map<string, { rotulo: string; n: number; exemplo: string }>();
  for (const r of resumo.recusados) {
    if (r.motivo !== 'OPCAO_SEM_POLITICA' || !r.opcao) continue;
    const atual = porOpcao.get(r.opcao.abreviacao);
    if (atual) atual.n += 1;
    else porOpcao.set(r.opcao.abreviacao, { rotulo: r.opcao.rotulo, n: 1, exemplo: r.origemId });
  }
  for (const [abrev, info] of porOpcao) {
    const abriu = await registrarPendencia({
      entidade: 'FREQUENCIA',
      chaveNatural: `OPCAO:${abrev}`,
      veredito: 'OPCAO_SEM_POLITICA',
      porque:
        `O Toddle usa o código "${info.rotulo}" (${abrev}) e não há tradução para ` +
        'PRESENCA no RM, então estes lançamentos NÃO chegam ao RM. Resolver aqui é ' +
        'decidir a POLÍTICA (POLITICA_PRESENCA em attendanceProjection.ts), não ' +
        'lançar falta à mão.',
      valorDesejado: null,
      valorNoRm: null,
      // O hash é do CÓDIGO, não de um valor: reabrir só faz sentido se a escola
      // renomear a opção, e é isso que este hash detecta.
      hashDesejado: hashValor(`${abrev}|${info.rotulo}`),
      origemId: info.exemplo,
    });
    if (abriu) pendenciasAbertas += 1;
  }

  const fila = await resumoPendencias();

  const base: RelatorioDeFrequencia = {
    janela,
    codFilial,
    coligada: cfg.rm.escopo.coligada,
    configVersion: versao,
    chaveRun,
    chaveDeAprovacao,
    turmasEmEscopo: turmasEmEscopo.length,
    alunosMapeados: alunos.length,
    lidosDoToddle: registros.length,
    projetaveis: resumo.projetados.length,
    recusadosNaProjecao: resumo.recusados.length,
    porMotivo: resumo.porMotivo ?? {},
    porVeredito: resumoDecisoes.porVeredito,
    aEscrever: resumoDecisoes.aEscrever,
    pendenciasDeDecisao: resumoDecisoes.pendencias,
    escreviveis: escreviveisLotes.map(comoDataset),
    semAulasDadas: semAulasDadasLotes.map(comoDataset),
    volume: { veredito: volume.veredito, motivos: volume.motivos },
    filaDePendencias: { abertas: fila.abertas, nestaPassada: pendenciasAbertas },
    escrita: false,
  };

  /**
   * Toda saída antecipada REGISTRA a passada.
   *
   * "Rodou e não havia o que escrever" é um desfecho legítimo e frequente. Ele
   * precisa aparecer, com o motivo, senão é indistinguível de "não rodou" — que
   * é a confusão exata que este projeto já pagou caro para não repetir.
   *
   * O estado não é sempre `succeeded`: teto recusado e aprovação pendente pedem
   * gente, e pintá-los de verde os esconderia.
   *
   * O ENSAIO é a exceção e não grava run: é um humano olhando, não uma passada
   * agendada, e registrá-lo faria o histórico mentir sobre quando o fluxo rodou
   * sozinho.
   */
  async function registrarPassada(
    naoEscreveu: NonNullable<RelatorioDeFrequencia['naoEscreveu']>,
    estado: 'succeeded' | 'failed',
  ): Promise<RelatorioDeFrequencia> {
    const runId = await abrirRun({
      tipo: 'attendance.sync',
      chave: chaveRun,
      inicio,
      configVersion: versao,
      payload: { janela, codFilial, operadoPor: op.quem ?? null, semEscrita: true },
    });
    await fecharRun(runId, estado, {
      naoEscreveu,
      lidosDoToddle: registros.length,
      projetaveis: resumo.projetados.length,
      recusadosNaProjecao: resumo.recusados.length,
      porMotivo: resumo.porMotivo ?? {},
      aEscrever: resumoDecisoes.aEscrever,
      pendencias: resumoDecisoes.pendencias,
      filaAberta: fila.abertas,
    });
    return { ...base, naoEscreveu };
  }

  if (!op.executar) return { ...base, naoEscreveu: 'ensaio' };
  if (escreviveisLotes.length === 0) return registrarPassada('nada-a-escrever', 'succeeded');

  // RECUSADO não tem porta: nem aprovação humana libera, porque o veredito
  // significa "isto não parece com o trabalho de um dia", e o caminho certo é
  // investigar o escopo, não autorizar.
  if (volume.veredito === 'RECUSADO') return registrarPassada('recusado-pelo-teto', 'failed');

  if (volume.veredito === 'PRECISA_APROVACAO' && !(await estaAprovado(chaveDeAprovacao))) {
    await pedirAprovacao({
      // A chave da INTENÇÃO: é por ela que a passada seguinte reencontra a
      // decisão. Com a chave por execução, a aprovação ficaria órfã e o gate
      // pediria decisão de novo a cada rodada.
      chave: chaveDeAprovacao,
      tipo: 'frequencia_toddle_para_rm',
      payload: {
        janela,
        codFilial,
        turmas: turmasEmEscopo.length,
        aEscrever: resumoDecisoes.aEscrever,
        datasets: escreviveisLotes.map(comoDataset),
        motivosDoTeto: volume.motivos,
        configVersion: versao,
        propostoPor: op.quem ?? null,
      },
    });
    return registrarPassada('precisa-aprovacao', 'failed');
  }

  // ─── ESCRITA ──────────────────────────────────────────────────────────────
  const runId = await abrirRun({
    tipo: 'attendance.sync',
    chave: chaveRun,
    inicio,
    configVersion: versao,
    payload: {
      janela,
      codFilial,
      turmas: turmasEmEscopo.length,
      datasets: escreviveisLotes.length,
      aEscrever: resumoDecisoes.aEscrever,
      operadoPor: op.quem ?? null,
    },
    resultadoInicial: { emEscopo: resumo.projetados.length },
  });
  const contexto = `CODCOLIGADA=${cfg.rm.escopo.coligada};CODFILIAL=${codFilial};CODTIPOCURSO=1;CODSISTEMA=S`;

  let recusadas: Array<{ linha: Projetado; resposta: string }> = [];
  let desconhecidas: Projetado[] = [];
  const escritas: Projetado[] = [];
  let chamadas = 0;
  let feitos = 0;

  for (const lote of escreviveisLotes) {
    progresso({ fase: 'escrevendo no RM', feitos, total: escreviveisLotes.length });
    feitos += 1;
    const r = await enviarComIsolamento(
      lote.linhas,
      (td, etapa) => alvos.aulasDadasDe(td, etapa),
      contexto,
    );
    chamadas += r.chamadas;
    escritas.push(...r.escritas);
    recusadas = [...recusadas, ...r.recusadas];
    desconhecidas = [...desconhecidas, ...r.desconhecidas];

    // Proveniência SÓ do que o RM aceitou, e nunca antes do aceite: registrar
    // escrita que não aconteceu faria a próxima passada tratar linha de
    // professor como nossa.
    for (const item of r.escritas) {
      await registrarEscrita({
        entidade: 'FREQUENCIA',
        chaveNatural: item.chaveRm,
        payloadHash: hashValor(item.linha.presenca),
        runId,
      });
    }
  }

  // ─── A LINHA QUE O RM RECUSOU VIRA PENDÊNCIA ──────────────────────────────
  //
  // Sem isto, a recusa viveria só no stdout de um run — e o aluno ficaria sem
  // frequência no RM para sempre, em silêncio. Ver a migration 013.
  for (const { linha, resposta } of recusadas) {
    const limpa = resposta.replace(/&#xD;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
    const abriu = await registrarPendencia({
      entidade: 'FREQUENCIA',
      chaveNatural: linha.chaveRm,
      veredito: 'RM_RECUSOU',
      porque:
        `O RM recusou ESTA linha (as demais do mesmo lote foram escritas). ` +
        `Resposta do RM: "${limpa}". A causa mais comum medida é o aluno não ter ` +
        `vínculo com a turma-disciplina no RM — estar na turma não basta. ` +
        `Confira a matrícula do RA ${linha.linha.ra} na IDTURMADISC ${linha.linha.idTurmaDisc}.`,
      valorDesejado: linha.linha.presenca,
      valorNoRm: null,
      hashDesejado: hashValor(linha.linha.presenca),
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
  // A `SFREQUENCIA` guarda AUSÊNCIA: uma linha `PRESENCA='P'` não cria registro,
  // ela remove se houver. Então "não achei a linha" significa duas coisas
  // indistinguíveis para um 'P': deu certo, ou nunca saiu daqui. A primeira
  // versão contava os 'P' como confirmados e imprimiu "23/25 conferidas" num run
  // em que o RM recusou TUDO — número tranquilizador e falso. As duas populações
  // são contadas separadas, e só a das ausências é chamada de conferida.
  const depois = await fetchFrequenciaFromRm(janela);
  const agora = indexaFaltasPorChave(depois.faltas);

  const ausenciasEsperadas = escritas.filter((i) => i.linha.presenca !== 'P');
  const ausenciasConfirmadas = ausenciasEsperadas.filter((i) => agora.has(i.chaveRm));
  const presencasEnviadas = escritas.length - ausenciasEsperadas.length;

  const ok =
    desconhecidas.length === 0 && ausenciasConfirmadas.length === ausenciasEsperadas.length;

  const envio = {
    escritas: escritas.length,
    recusadas: recusadas.length,
    desconhecidas: desconhecidas.length,
    chamadas,
    faltasAntes: noRm.faltas.length,
    faltasDepois: depois.faltas.length,
    ausenciasEsperadas: ausenciasEsperadas.length,
    ausenciasConfirmadas: ausenciasConfirmadas.length,
    presencasEnviadas,
    amostraDeRecusas: recusadas.slice(0, 10).map(({ linha }) => ({
      ra: linha.linha.ra,
      idTurmaDisc: linha.linha.idTurmaDisc,
      data: linha.linha.data,
    })),
    ok,
  };

  await fecharRun(runId, ok ? 'succeeded' : 'failed', envio);

  return {
    ...base,
    escrita: true,
    filaDePendencias: { abertas: fila.abertas, nestaPassada: pendenciasAbertas },
    envio,
  };
}
