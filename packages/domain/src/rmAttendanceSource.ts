import { createHash } from 'node:crypto';
import { env, isRmSoapConfigured, logger } from '@rm-toddle/config';
import { wsConsultaSqlClient, type ConsultaRow } from '@rm-toddle/integrations';

/**
 * Fonte de FREQUÊNCIA do RM, via Sentença `TODDLE.FREQ` no wsConsultaSQL.
 *
 * Existe porque o `ReadView` dos DataServers de frequência usa filtro posicional
 * cuja gramática não descobrimos (6 formas tentadas). A Sentença é o único
 * caminho de leitura por data — ver docs/rm-sentencas/TODDLE.FREQ.ESPEC.md.
 *
 * ─── O QUE FOI MEDIDO, E QUE MOLDA ESTE MÓDULO ──────────────────────────────
 *
 * 1. `PRESENCA = 'A'` em 100% das linhas. O `SFREQUENCIA` guarda SÓ AUSÊNCIA;
 *    presença é a ausência de linha. Então cada linha lida aqui é uma FALTA.
 *
 * 2. `CRIADO_POR` traz **CPF de professor** (41 dos 45 autores). É dado pessoal:
 *    este módulo NUNCA propaga o valor. Ele deriva `criadoPelaIntegracao` e um
 *    hash com sal, e descarta o original — ver `classificaAutor`.
 *
 * 3. O lançamento é RETROATIVO: faltas de fevereiro foram criadas entre março e
 *    maio. Logo a marca d'água de sync é `ALTERADO_EM`, nunca a data da aula.
 *    Este módulo devolve `alteradoEm` justamente para isso.
 *
 * 4. A Sentença exige QUATRO parâmetros: CODCOLIGADA, CODPERLET, DATAINICIAL e
 *    DATAFINAL (as datas no estilo 112, YYYYMMDD).
 */

/** Uma falta lançada no RM, já sem dado pessoal. */
export interface RmFalta {
  codColigada: string;
  ra: string;
  idTurmaDisc: string;
  /** "YYYY-MM-DD" — data da aula. */
  data: string;
  idHorarioTurma: string;
  /** Medido: sempre 'A'. Mantido para detectar mudança de domínio. */
  presenca: string;
  justificada: boolean;
  idJustificativa?: string;
  justificativa?: string;
  /** `COMPOETOTALFALTAS`: se a justificativa entra no total que conta para os 75%. */
  justificativaCompoeTotal?: boolean;

  /** Sufixo do CODHOR. ATENÇÃO: só é 1:1 com a hora no campus 2 — ver §3.4 da ESPEC. */
  faixa?: string;
  codHor?: string;
  /** '2'=segunda … '6'=sexta, convenção do RM (domingo=1). */
  diaSemana?: string;
  horaInicial?: string;
  horaFinal?: string;

  codFilial: string;
  codTurma?: string;
  codDisc?: string;

  /** A falta foi criada pela própria integração? Decide se remoção é automática. */
  criadoPelaIntegracao: boolean;
  /** Hash com sal do autor. NUNCA o CPF. Só para correlacionar sem identificar. */
  autorHash: string;
  /** ISO com hora. Marca d'água do sync incremental. */
  alteradoEm?: string;
  criadoEm?: string;
  /** A linha foi tocada depois de criada? Medido: 0 de 2.449 em fevereiro. */
  alteradaDepoisDeCriada: boolean;
}

export interface JanelaFrequencia {
  /** "YYYY-MM-DD" */
  de: string;
  ate: string;
}

export interface ResumoLeituraFrequencia {
  linhas: number;
  faltas: RmFalta[];
  foraDoEscopo: number;
  semRa: number;
  /** Domínios observados, para detectar mudança no RM sem ninguém avisar. */
  dominioPresenca: Record<string, number>;
  /** Quantas foram criadas pela integração (hoje: 0). */
  criadasPelaIntegracao: number;
  alteradasDepoisDeCriadas: number;
  /** Maior ALTERADO_EM visto — a próxima marca d'água. */
  marcaDagua?: string;
}

/** "2026-02-03" → "20260203", o estilo 112 que a Sentença espera. */
export function paraEstilo112(dataIso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataIso)) {
    throw new Error(`paraEstilo112 esperava "YYYY-MM-DD", recebeu ${JSON.stringify(dataIso)}`);
  }
  return dataIso.replace(/-/g, '');
}

/**
 * Classifica o autor SEM propagar o CPF.
 *
 * Só duas coisas interessam ao desenho: se fomos nós que escrevemos, e um
 * identificador estável para correlacionar linhas do mesmo autor sem saber quem
 * é. O sal é o tenant, para o hash não ser comparável entre escolas.
 */
function classificaAutor(autor: string | undefined): { integracao: boolean; hash: string } {
  const bruto = (autor ?? '').trim();
  if (bruto === '') return { integracao: false, hash: '' };
  const usuarioIntegracao = (env.RM_WS_USER ?? '').trim();
  return {
    integracao: usuarioIntegracao !== '' && bruto.toLowerCase() === usuarioIntegracao.toLowerCase(),
    hash: createHash('sha256').update(`${env.TENANT_SLUG}:${bruto}`).digest('hex').slice(0, 16),
  };
}

/**
 * Lê a frequência do RM numa janela de datas.
 *
 * A janela é OBRIGATÓRIA: a Sentença exige, e são 21.300 linhas no ano inteiro
 * nos dois campi. O recorte por campus é fail-closed, igual ao do roster.
 */
export async function fetchFrequenciaFromRm(
  janela: JanelaFrequencia,
): Promise<ResumoLeituraFrequencia> {
  if (!isRmSoapConfigured) {
    throw new Error('wsConsultaSQL não configurado (RM_WS_BASEURL/RM_WS_USER/RM_WS_PASS).');
  }
  if (!env.RM_SENTENCA_FREQUENCIA) {
    throw new Error(
      'RM_SENTENCA_FREQUENCIA não definido — informe o código da Sentença de frequência ' +
        '(ex.: TODDLE.FREQ). Ver docs/rm-sentencas/TODDLE.FREQ.ESPEC.md.',
    );
  }
  if (!env.RM_CODPERLET) {
    throw new Error('RM_CODPERLET não definido — a Sentença de frequência exige o período letivo.');
  }
  if (janela.de > janela.ate) {
    throw new Error(`Janela invertida: de ${janela.de} é depois de até ${janela.ate}.`);
  }

  const rows = await wsConsultaSqlClient.realizarConsulta(env.RM_SENTENCA_FREQUENCIA, {
    CODCOLIGADA: env.RM_CODCOLIGADA,
    CODPERLET: env.RM_CODPERLET,
    DATAINICIAL: paraEstilo112(janela.de),
    DATAFINAL: paraEstilo112(janela.ate),
  });

  // Mesmo recorte fail-closed do roster: "ALL" tem de ser declarado, nunca é default.
  const todosCampi = env.RM_CODFILIAL.trim().toUpperCase() === 'ALL';
  const campiPermitidos = todosCampi
    ? []
    : env.RM_CODFILIAL.split(',').map((s) => s.trim()).filter(Boolean);
  if (!todosCampi && campiPermitidos.length === 0) {
    throw new Error(
      `RM_CODFILIAL="${env.RM_CODFILIAL}" não produziu nenhum campus válido.`,
    );
  }

  const faltas: RmFalta[] = [];
  const dominioPresenca: Record<string, number> = {};
  let foraDoEscopo = 0;
  let semRa = 0;
  let criadasPelaIntegracao = 0;
  let alteradasDepoisDeCriadas = 0;
  let marcaDagua: string | undefined;

  for (const row of rows) {
    const ra = pick(row, 'RA');
    if (!ra) {
      semRa += 1;
      continue;
    }

    const codFilial = pick(row, 'CODFILIAL') ?? '';
    if (!todosCampi && !campiPermitidos.includes(codFilial)) {
      foraDoEscopo += 1;
      continue;
    }

    const presenca = pick(row, 'PRESENCA') ?? '';
    dominioPresenca[presenca] = (dominioPresenca[presenca] ?? 0) + 1;

    const criadoEm = pick(row, 'CRIADO_EM');
    const alteradoEm = pick(row, 'ALTERADO_EM');
    const tocada = Boolean(criadoEm && alteradoEm && criadoEm.slice(0, 19) !== alteradoEm.slice(0, 19));
    if (tocada) alteradasDepoisDeCriadas += 1;
    if (alteradoEm && (marcaDagua === undefined || alteradoEm > marcaDagua)) marcaDagua = alteradoEm;

    const autor = classificaAutor(pick(row, 'CRIADO_POR'));
    if (autor.integracao) criadasPelaIntegracao += 1;

    const data = toIsoDate(pick(row, 'DATA'));
    if (!data) {
      logger.warn({ ra, valor: pick(row, 'DATA') }, 'Frequência com DATA ilegível — descartada');
      continue;
    }

    faltas.push({
      codColigada: pick(row, 'CODCOLIGADA') ?? String(env.RM_CODCOLIGADA),
      ra,
      idTurmaDisc: pick(row, 'ID_TURMADISC', 'IDTURMADISC') ?? '',
      data,
      idHorarioTurma: pick(row, 'ID_HORARIO_TURMA', 'IDHORARIOTURMA') ?? '',
      presenca,
      justificada: (pick(row, 'JUSTIFICADA') ?? '').toUpperCase() === 'S',
      idJustificativa: pick(row, 'ID_JUSTIFICATIVA', 'IDJUSTIFICATIVAFALTA'),
      justificativa: pick(row, 'JUSTIFICATIVA_DESCRICAO', 'JUSTIFICATIVA'),
      justificativaCompoeTotal: simNaoOuUndefined(pick(row, 'COMPOE_TOTAL_FALTAS')),
      faixa: pick(row, 'FAIXA_DE_CODHOR', 'FAIXA'),
      codHor: pick(row, 'CODHOR'),
      diaSemana: pick(row, 'DIASEMANA'),
      horaInicial: normalizaHoraSimples(pick(row, 'HORAINICIAL')),
      horaFinal: normalizaHoraSimples(pick(row, 'HORAFINAL')),
      codFilial,
      codTurma: pick(row, 'COD_TURMA', 'CODTURMA'),
      codDisc: pick(row, 'CODDISC'),
      criadoPelaIntegracao: autor.integracao,
      autorHash: autor.hash,
      alteradoEm,
      criadoEm,
      alteradaDepoisDeCriada: tocada,
    });
  }

  // O log NÃO inclui autor nem hash: CPF não entra em log, e hash em log é
  // convite para correlacionar depois. Ver §3.7 da ESPEC.
  logger.info(
    {
      janela: `${janela.de} → ${janela.ate}`,
      linhas: rows.length,
      faltas: faltas.length,
      foraDoEscopo,
      semRa,
      dominioPresenca,
      criadasPelaIntegracao,
      alteradasDepoisDeCriadas,
      marcaDagua,
      campi: campiPermitidos.length > 0 ? campiPermitidos.join(',') : 'todos',
    },
    'Frequência lida do RM via wsConsultaSQL',
  );

  return {
    linhas: rows.length,
    faltas,
    foraDoEscopo,
    semRa,
    dominioPresenca,
    criadasPelaIntegracao,
    alteradasDepoisDeCriadas,
    marcaDagua,
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

/** "2026-02-03T00:00:00" ou "03/02/2026" → "2026-02-03". */
function toIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const br = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(value);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return undefined;
}

/** "08:00" / "08:00:00" → "08:00". */
function normalizaHoraSimples(valor: string | undefined): string | undefined {
  if (!valor) return undefined;
  const m = /^(\d{1,2}):(\d{2})/.exec(valor.trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : undefined;
}

function simNaoOuUndefined(valor: string | undefined): boolean | undefined {
  if (valor == null || valor === '') return undefined;
  const v = valor.trim().toUpperCase();
  if (v === 'S' || v === '1' || v === 'TRUE') return true;
  if (v === 'N' || v === '0' || v === 'FALSE') return false;
  return undefined;
}
