import { alertar, env, logger, rmSoapConfigurado, tenantConfig } from '@rm-toddle/config';
import { wsConsultaSqlClient, type ConsultaRow } from '@rm-toddle/integrations';
import { colunasAusentesNoResultSet, explicarColunasAusentes } from './colunasDaChave';
import type { EstadoNoRm } from './rmWriteDecision';
import { canonizarNota } from './notaCanonica';

/**
 * A config da escola que este processo atende.
 *
 * `tenantConfig` em vez de `env`: quando a origem virar a tabela
 * `integration_connection`, nada aqui muda. Função NOVA deve receber
 * `cfg: TenantConfig` como parâmetro em vez de usar esta constante — ver a nota
 * em packages/config/src/tenantConfig.ts.
 */
const cfg = tenantConfig;

/**
 * Fonte de NOTAS do RM, via Sentença `TODDLE.NOTAS`.
 *
 * Alimenta `POST /public/v2/term-grades`. Ver
 * docs/rm-sentencas/TODDLE.NOTAS.ESPEC.md.
 *
 * ─── O QUE FOI MEDIDO, E QUE MOLDA ESTE MÓDULO ──────────────────────────────
 *
 * 1. A nota é NUMÉRICA, de 0 a 7 (250 valores distintos, 4 decimais). As duas
 *    escalas do Toddle são ALFABÉTICAS (EXEM/EXC/… e A–E), e a tabela de conceito
 *    do RM está VAZIA — `COD_CONCEITO` em 0 de 3.876. Não existe régua oficial de
 *    número para letra, então a nota vai como *overall score*: só `postedGrade`,
 *    sem `gradeScaleId` e sem `criteriaType`, que é o que a API permite.
 *
 * 2. `ETAPA_LIBERADA = 'N'` em 100% das linhas. Sob a regra segura, nada é
 *    publicável — publicar nota não liberada mostra à família resultado
 *    provisório. Este módulo NÃO filtra por isso: ele MARCA cada nota e deixa a
 *    decisão para quem consome, porque ainda não se sabe se a flag é gerenciada
 *    ou se nunca é tocada nesta escola.
 *
 * 3. A chave `(RA, IDTURMADISC, CODETAPA)` é única — 3.876 para 3.876.
 *
 * 4. O de-para de etapa é por ORDINAL (etapa 1 → T1), não por data: as janelas
 *    do Toddle e do RM divergem. Ver migração 008.
 */

/** Uma nota de etapa, já recortada e tipada. */
export interface RmNota {
  codColigada: string;
  ra: string;
  idTurmaDisc: string;
  /** '1' | '2' | '3' — vira gradingPeriodId pelo de-para GRADING_PERIOD. */
  codEtapa: string;
  etapa: string;
  /** A nota como o RM guarda: string numérica de 0 a 7. Nunca convertida aqui. */
  nota: string;
  /** `nota` como número, para validação. NaN vira `undefined`. */
  notaNumerica?: number;
  codDisc?: string;
  disciplina?: string;
  codTurma?: string;
  codFilial: string;
  /** A etapa foi liberada ao aluno? Medido: 'N' em 100%. */
  etapaLiberada: boolean;
  /** Matrícula ativa na turma. 24 de 3.876 vinham 'N'. */
  alunoAtivo: boolean;
  statusDescricao?: string;
  criadoPelaIntegracao: boolean;
  alteradoEm?: string;
  criadoEm?: string;
}

export interface ResumoNotas {
  linhas: number;
  notas: RmNota[];
  foraDoEscopo: number;
  /**
   * Linhas descartadas por componente VAZIO da chave natural.
   *
   * Separado de `foraDoEscopo` de propósito: os dois significam coisas
   * opostas. "Fora do escopo" é "deliberadamente não nos interessa"; "sem
   * chave" é "NÃO CONSEGUIMOS VER uma nota que alguém lançou". Somá-los, como
   * era antes, torna impossível distinguir indiferença de cegueira.
   */
  semChave: number;
  /** Linha de nota vazia — etapa aberta e ainda não lançada. */
  semNota: number;
  /** Domínios observados, para detectar mudança no RM sem aviso. */
  dominioEtapa: Record<string, number>;
  /** Quantas estão em etapa liberada. Hoje: 0. */
  emEtapaLiberada: number;
  /** Quantas são de aluno com matrícula inativa naquela turma. */
  deAlunoInativo: number;
  /** Maior ALTERADO_EM — marca d'água do sync incremental. */
  marcaDagua?: string;
  /** Faixa observada da nota, para detectar mudança de escala. */
  faixaNota?: { min: number; max: number };
}

const ehSim = (v: string | undefined): boolean =>
  ['S', 'SIM', '1', 'TRUE'].includes((v ?? '').trim().toUpperCase());

/**
 * Lê as notas do RM, recortadas por campus e pelo escopo de turma e aluno.
 *
 * @param idsTurmaDisc IDTURMADISC com mapeamento COURSE ativo.
 * @param ras RAs com mapeamento STUDENT ativo.
 *
 * Ambos são interseção POSITIVA: lista vazia é erro, nunca "tudo".
 */
export async function fetchNotasFromRm(
  idsTurmaDisc: string[],
  ras: string[],
): Promise<ResumoNotas> {
  if (!rmSoapConfigurado) {
    throw new Error('wsConsultaSQL não configurado (RM_WS_BASEURL/RM_WS_USER/RM_WS_PASS).');
  }
  if (!cfg.rm.sentencas.notas) {
    throw new Error(
      'RM_SENTENCA_NOTAS não definido — informe o código da Sentença de notas (ex.: TODDLE.NOTAS).',
    );
  }
  if (!cfg.rm.escopo.periodoLetivo) {
    throw new Error('RM_CODPERLET não definido — a Sentença de notas exige o período letivo.');
  }
  if (idsTurmaDisc.length === 0 || ras.length === 0) {
    throw new Error(
      'fetchNotasFromRm recebeu escopo vazio (turma ou aluno). Isto é recusa, não "ler tudo".',
    );
  }

  const rows = await wsConsultaSqlClient.realizarConsulta(cfg.rm.sentencas.notas, {
    CODCOLIGADA: cfg.rm.escopo.coligada,
    CODPERLET: cfg.rm.escopo.periodoLetivo,
  });

  const turmas = new Set(idsTurmaDisc);
  const alunos = new Set(ras);
  const todosCampi = cfg.rm.escopo.filiais.trim().toUpperCase() === 'ALL';
  const campiPermitidos = todosCampi
    ? []
    : cfg.rm.escopo.filiais.split(',').map((s) => s.trim()).filter(Boolean);

  const notas: RmNota[] = [];
  const dominioEtapa: Record<string, number> = {};
  /*
   * ─── DRIFT DE SENTENÇA: ANTES DE QUALQUER LINHA ──────────────────────────
   *
   * Mesmo desenho do P0-6 na frequência, pelo mesmo motivo: coluna ausente é
   * propriedade do RESULT SET, não da linha. Se sumiu, sumiu para todas —
   * falhar no meio do laço deixaria metade das notas lidas e metade não, e
   * estado parcial é pior que falha limpa quando o próximo passo decide
   * escrita em boletim.
   *
   * A FLAG É PRÓPRIA das notas, e não a da frequência: o critério de ativação
   * é "N observações do cron sem alerta", e as cadências diferem em ordem de
   * grandeza — 1 observação/dia contra 34. Ver a nota em `env.ts`.
   */
  const ausentes = colunasDaChaveDeNotaAusentes(rows);
  if (ausentes.length > 0) {
    const estrito = env.FALHA_ALTA_COLUNA_AUSENTE_NOTAS === 'true';
    const explicacao = explicarColunasAusentes({
      fluxo: 'notas',
      sentenca: cfg.rm.sentencas.notas ?? '(sem código)',
      ausentes,
    });

    logger.error({ ausentes, estrito, sentenca: cfg.rm.sentencas.notas }, explicacao);
    await alertar({
      // Assunto ESTÁVEL: as colunas vão no contexto. Contrato do P0-2.
      assunto: 'Notas: a Sentença perdeu coluna da chave natural',
      contexto: {
        colunasAusentes: ausentes.join(', '),
        sentenca: cfg.rm.sentencas.notas,
        modo: estrito ? 'ESTRITO — o run foi abortado' : 'SOMBRA — o run seguiu',
        porqueImporta:
          'nota sobrescrita entra no boletim e no histórico, e a proteção contra ' +
          'sobrescrever lançamento de professor depende desta chave',
        comoVer: 'npm run canario -- --executar',
      },
      repetirApos: 6 * 60 * 60 * 1_000,
    });

    if (estrito) throw new Error(explicacao);
  }

  let foraDoEscopo = 0;
  let semChave = 0;
  let semNota = 0;
  let emEtapaLiberada = 0;
  let deAlunoInativo = 0;
  let marcaDagua: string | undefined;
  let min = Infinity;
  let max = -Infinity;

  for (const row of rows) {
    const ra = pick(row, 'RA');
    const idTurmaDisc = pick(row, 'ID_TURMADISC', 'IDTURMADISC');
    const codFilial = pick(row, 'CODFILIAL') ?? '';

    /*
     * ─── DOIS DESCARTES COM SIGNIFICADOS OPOSTOS ─────────────────────────
     *
     * Antes os dois incrementavam `foraDoEscopo`, e a contagem misturava:
     *
     *   fora do escopo   deliberadamente não nos interessa — outro campus,
     *                    turma que o Toddle não cobre, aluno não mapeado.
     *                    Zero risco: nem projetamos nada para essas linhas.
     *   sem chave        a linha EXISTE, é nota lançada por alguém, e nós não
     *                    conseguimos enxergá-la. A projeção correspondente vai
     *                    responder ESCREVER_NOVO e escrever por cima.
     *
     * Misturados num contador só, "não conseguimos ver 40 notas humanas" fica
     * indistinguível de "40 linhas de outro campus" — e a segunda é rotina.
     */
    if (!ra || !idTurmaDisc) {
      semChave += 1;
      continue;
    }

    // Recorte em três: campus, turma e aluno. Todos precisam bater.
    if (
      (!todosCampi && !campiPermitidos.includes(codFilial)) ||
      !turmas.has(idTurmaDisc) ||
      !alunos.has(ra)
    ) {
      foraDoEscopo += 1;
      continue;
    }

    // A Sentença já filtra TIPOETAPA='N', mas confiar sem conferir é como o
    // SELECT TOP 30 da Sentença de alunos: passa despercebido por dias.
    const tipo = pick(row, 'TIPOETAPA', 'TIPO_ETAPA');
    if (tipo && tipo.toUpperCase() !== 'N') {
      foraDoEscopo += 1;
      continue;
    }

    /*
     * ─── A ÚLTIMA BRECHA DA CHAVE ────────────────────────────────────────
     *
     * Dos quatro componentes de `codColigada|codEtapa|N|idTurmaDisc|ra`, três
     * já estavam guardados: `ra` e `idTurmaDisc` descartam a linha logo acima,
     * e `codColigada` cai para a coligada do escopo, que é um default correto.
     *
     * `codEtapa` era o único com `?? ''`, e com ele vazio a chave vira
     * `1||N|1714|RA` — não casa com nada, e a nota que o professor lançou fica
     * invisível para a decisão de escrita.
     */
    const codEtapaBruto = pick(row, 'CODETAPA', 'COD_ETAPA');
    dominioEtapa[codEtapaBruto || '(vazio)'] = (dominioEtapa[codEtapaBruto || '(vazio)'] ?? 0) + 1;
    if (!codEtapaBruto) {
      semChave += 1;
      logger.warn(
        { ra, idTurmaDisc },
        'Nota sem CODETAPA — descartada. A coluna existe no result set, mas veio vazia nesta ' +
          'linha; seguir com segmento vazio na chave faria a nota do professor ficar invisível ' +
          'para a decisão de escrita',
      );
      continue;
    }
    const codEtapa = codEtapaBruto;

    const nota = pick(row, 'NOTA');
    if (!nota) semNota += 1;

    const numerica = nota ? Number(nota.replace(',', '.')) : NaN;
    if (Number.isFinite(numerica)) {
      if (numerica < min) min = numerica;
      if (numerica > max) max = numerica;
    }

    const liberada = ehSim(pick(row, 'ETAPA_LIBERADA'));
    if (liberada) emEtapaLiberada += 1;
    const ativo = ehSim(pick(row, 'STATUS_ATIVO'));
    if (!ativo) deAlunoInativo += 1;

    const alteradoEm = pick(row, 'ALTERADO_EM');
    if (alteradoEm && (marcaDagua === undefined || alteradoEm > marcaDagua)) marcaDagua = alteradoEm;

    const autor = (pick(row, 'CRIADO_POR') ?? '').trim().toLowerCase();
    const usuarioIntegracao = (cfg.rm.conexao.usuario ?? '').trim().toLowerCase();

    notas.push({
      codColigada: pick(row, 'CODCOLIGADA') ?? String(cfg.rm.escopo.coligada),
      ra,
      idTurmaDisc,
      codEtapa,
      etapa: pick(row, 'ETAPA') ?? '',
      nota: nota ?? '',
      notaNumerica: Number.isFinite(numerica) ? numerica : undefined,
      codDisc: pick(row, 'CODDISC'),
      disciplina: pick(row, 'DISCIPLINA'),
      codTurma: pick(row, 'COD_TURMA', 'CODTURMA'),
      codFilial,
      etapaLiberada: liberada,
      alunoAtivo: ativo,
      statusDescricao: pick(row, 'STATUS_DESCRICAO'),
      // Não guardamos o autor: CRIADO_POR traz CPF na frequência, e aqui o padrão
      // é o mesmo. Só interessa se fomos nós.
      criadoPelaIntegracao: usuarioIntegracao !== '' && autor === usuarioIntegracao,
      alteradoEm,
      criadoEm: pick(row, 'CRIADO_EM'),
    });
  }

  logger.info(
    {
      linhas: rows.length,
      notas: notas.length,
      foraDoEscopo,
      semChave,
      semNota,
      dominioEtapa,
      emEtapaLiberada,
      deAlunoInativo,
      marcaDagua,
      faixaNota: Number.isFinite(min) ? `${min}–${max}` : undefined,
    },
    'Notas lidas do RM via wsConsultaSQL',
  );

  return {
    linhas: rows.length,
    notas,
    foraDoEscopo,
    semChave,
    semNota,
    dominioEtapa,
    emEtapaLiberada,
    deAlunoInativo,
    marcaDagua,
    faixaNota: Number.isFinite(min) ? { min, max } : undefined,
  };
}

/** Busca uma coluna por vários nomes possíveis (case-insensitive), trimada. */
function pick(row: ConsultaRow, ...names: string[]): string | undefined {
  for (const name of names) {
    const direct = row[name];
    if (direct != null && direct !== '') return direct;
  }
  const lowered = new Map(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
  for (const name of names) {
    const v = lowered.get(name.toLowerCase());
    if (v != null && v !== '') return v;
  }
  return undefined;
}

// ============================================================
//  A via de volta: o que o RM TEM hoje, para a decisão de escrita.
//  Ver rmWriteDecision.ts — a segunda das três evidências.
// ============================================================

/**
 * Traduz a nota lida do RM no `EstadoNoRm` que `decidirEscrita` consome.
 *
 * A autoria vem DERIVADA, nunca crua: `RECCREATEDBY` no RM traz CPF de
 * professor, e `rmGradeSource` já reduziu isso a um booleano na leitura. Este
 * módulo não é a porta por onde o CPF volta a circular.
 */
export function estadoNoRmDeNota(n: RmNota): EstadoNoRm {
  return {
    // Canônica: ver a nota em `notaCanonica` sobre "9" × "9.0000".
    valor: canonizarNota(n.nota),
    autoriaEhIntegracao: n.criadoPelaIntegracao,
    // `SNOTAETAPA` guarda RECCREATEDON e RECMODIFIEDON; a Sentença traz os dois.
    // Alterada depois de criada = alguém editou dentro do RM, e o veredito
    // `EDITADO_POR_FORA` existe justamente para não sobrescrever isso.
    tocadaDepoisDeCriada:
      Boolean(n.alteradoEm && n.criadoEm && n.alteradoEm > n.criadoEm),
  };
}

/**
 * Chave natural da nota do RM, na ORDEM do `xs:unique Constraint1` do XSD:
 * CODCOLIGADA, CODETAPA, TIPOETAPA, IDTURMADISC, RA.
 *
 * A Sentença TODDLE.NOTAS filtra `TIPOETAPA='N'`, então o tipo é constante aqui.
 * Precisa casar EXATAMENTE com `chaveNaturalNota` da projeção — duas convenções
 * de ordem fariam toda linha parecer nova, e `NADA_A_FAZER` viraria reescrita
 * perpétua.
 */
/**
 * As colunas sem as quais a chave da NOTA não existe.
 *
 * A chave é `codColigada|codEtapa|N|idTurmaDisc|ra` — o `N` é constante
 * (TIPOETAPA de nota) e não vem do result set.
 *
 * `CODCOLIGADA` NÃO entra: o leitor cai para `cfg.rm.escopo.coligada` quando
 * ela falta, e esse default é correto — a coligada do escopo é a mesma que a
 * Sentença consulta, porque ela vai como parâmetro da consulta. As outras três
 * não têm default possível.
 */
const COLUNAS_DA_CHAVE_DE_NOTA: ReadonlyArray<readonly string[]> = [
  ['RA'],
  ['ID_TURMADISC', 'IDTURMADISC'],
  ['CODETAPA', 'COD_ETAPA'],
];

/** Quais colunas da chave da nota não existem no result set. Ver colunasDaChave.ts. */
export function colunasDaChaveDeNotaAusentes(rows: readonly ConsultaRow[]): string[] {
  return colunasAusentesNoResultSet(rows, COLUNAS_DA_CHAVE_DE_NOTA);
}

export const chaveNaturalDeNota = (n: RmNota): string =>
  `${n.codColigada}|${n.codEtapa}|N|${n.idTurmaDisc}|${n.ra}`;

/** Índice das notas do RM por chave natural, para o cruzamento em lote. */
export function indexaNotasPorChave(notas: RmNota[]): Map<string, RmNota> {
  const m = new Map<string, RmNota>();
  for (const n of notas) m.set(chaveNaturalDeNota(n), n);
  return m;
}
