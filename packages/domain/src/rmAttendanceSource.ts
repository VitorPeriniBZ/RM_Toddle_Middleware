import { createHash } from 'node:crypto';
import { alertar, env, logger, rmSoapConfigurado, tenantConfig } from '@rm-toddle/config';
import { wsConsultaSqlClient, type ConsultaRow } from '@rm-toddle/integrations';
import { chaveNaturalRm } from './attendanceProjection';
import { colunasAusentesNoResultSet, explicarColunasAusentes } from './colunasDaChave';
import type { EstadoNoRm } from './rmWriteDecision';

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
  /** Linhas descartadas por componente vazio da chave natural. Ver o laço. */
  semChave: number;
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
  const usuarioIntegracao = (cfg.rm.conexao.usuario ?? '').trim();
  return {
    integracao: usuarioIntegracao !== '' && bruto.toLowerCase() === usuarioIntegracao.toLowerCase(),
    hash: createHash('sha256').update(`${cfg.slug}:${bruto}`).digest('hex').slice(0, 16),
  };
}

/**
 * As colunas sem as quais a chave da FREQUÊNCIA não existe.
 *
 * Não é a lista de tudo que a Sentença devolve: é só o que compõe a chave
 * natural, que é onde a ausência causa dano silencioso. Uma `JUSTIFICATIVA`
 * que suma empobrece o relatório; uma `ID_TURMADISC` que suma desliga a
 * proteção contra sobrescrever lançamento de professor.
 *
 * Cada entrada lista as variantes aceitas, iguais às que o `pick` tenta.
 */
const COLUNAS_DA_CHAVE: ReadonlyArray<readonly string[]> = [
  ['RA'],
  ['DATA'],
  ['ID_TURMADISC', 'IDTURMADISC'],
  ['ID_HORARIO_TURMA', 'IDHORARIOTURMA'],
];

/**
 * Quais colunas da chave da frequência não existem no result set.
 *
 * A lógica mora em `colunasDaChave.ts` e é COMPARTILHADA com o leitor de
 * notas: duas cópias de uma regra sutil divergem no dia em que alguém melhora
 * uma delas, que é o mesmo motivo de `chaveNaturalDeFalta` chamar
 * `chaveNaturalRm` em vez de reimplementá-la.
 */
export function colunasDaChaveAusentes(rows: readonly ConsultaRow[]): string[] {
  return colunasAusentesNoResultSet(rows, COLUNAS_DA_CHAVE);
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
  if (!rmSoapConfigurado) {
    throw new Error('wsConsultaSQL não configurado (RM_WS_BASEURL/RM_WS_USER/RM_WS_PASS).');
  }
  if (!cfg.rm.sentencas.frequencia) {
    throw new Error(
      'RM_SENTENCA_FREQUENCIA não definido — informe o código da Sentença de frequência ' +
        '(ex.: TODDLE.FREQ). Ver docs/rm-sentencas/TODDLE.FREQ.ESPEC.md.',
    );
  }
  if (!cfg.rm.escopo.periodoLetivo) {
    throw new Error('RM_CODPERLET não definido — a Sentença de frequência exige o período letivo.');
  }
  if (janela.de > janela.ate) {
    throw new Error(`Janela invertida: de ${janela.de} é depois de até ${janela.ate}.`);
  }

  const rows = await wsConsultaSqlClient.realizarConsulta(cfg.rm.sentencas.frequencia, {
    CODCOLIGADA: cfg.rm.escopo.coligada,
    CODPERLET: cfg.rm.escopo.periodoLetivo,
    DATAINICIAL: paraEstilo112(janela.de),
    DATAFINAL: paraEstilo112(janela.ate),
  });

  // Mesmo recorte fail-closed do roster: "ALL" tem de ser declarado, nunca é default.
  const todosCampi = cfg.rm.escopo.filiais.trim().toUpperCase() === 'ALL';
  const campiPermitidos = todosCampi
    ? []
    : cfg.rm.escopo.filiais.split(',').map((s) => s.trim()).filter(Boolean);
  if (!todosCampi && campiPermitidos.length === 0) {
    throw new Error(
      `RM_CODFILIAL="${cfg.rm.escopo.filiais}" não produziu nenhum campus válido.`,
    );
  }

  /*
   * ─── DRIFT DE SENTENÇA: ANTES DE QUALQUER LINHA ──────────────────────────
   *
   * A checagem vem AQUI, antes do laço, e não dentro dele, porque coluna
   * ausente é propriedade do RESULT SET: se sumiu, sumiu para todas as linhas.
   * Falhar no meio do laço deixaria metade das faltas lidas e a outra metade
   * não — estado parcial é pior que falha limpa quando o próximo passo é
   * decidir escrita no registro acadêmico.
   */
  const ausentes = colunasDaChaveAusentes(rows);
  if (ausentes.length > 0) {
    const estrito = env.FALHA_ALTA_COLUNA_AUSENTE_FREQUENCIA === 'true';
    const explicacao = explicarColunasAusentes({
      fluxo: 'frequência',
      sentenca: cfg.rm.sentencas.frequencia ?? '(sem código)',
      ausentes,
    });

    logger.error({ ausentes, estrito, sentenca: cfg.rm.sentencas.frequencia }, explicacao);
    await alertar({
      // Assunto ESTÁVEL: as colunas vão no contexto. Contrato do P0-2.
      assunto: 'Frequência: a Sentença perdeu coluna da chave natural',
      contexto: {
        colunasAusentes: ausentes.join(', '),
        sentenca: cfg.rm.sentencas.frequencia,
        modo: estrito ? 'ESTRITO — o run foi abortado' : 'SOMBRA — o run seguiu como antes',
        porqueImporta: 'a proteção contra sobrescrever lançamento de professor depende desta chave',
        comoVer: 'npm run canario -- --executar',
      },
      repetirApos: 6 * 60 * 60 * 1_000,
    });

    if (estrito) throw new Error(explicacao);
  }

  const faltas: RmFalta[] = [];
  const dominioPresenca: Record<string, number> = {};
  let foraDoEscopo = 0;
  let semRa = 0;
  let semChave = 0;
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

    /*
     * ─── VALOR VAZIO NUMA LINHA: DESCARTA A LINHA ────────────────────────
     *
     * Aqui a coluna EXISTE no result set — isso já foi conferido antes do laço
     * — e mesmo assim veio vazia neste registro. É problema de uma linha, não
     * da Sentença, e a reação é a mesma que a `DATA` ilegível já recebia:
     * descartar com aviso.
     *
     * ─── E ISTO NÃO É PROTEÇÃO. É CONTENÇÃO. ────────────────────────────
     *
     * Vale dizer com todas as letras, porque a tentação de achar que resolve é
     * real: descartar a linha e manter a chave degradada levam ao MESMO
     * desfecho para aquela aula — a projeção não encontra nada, responde
     * ESCREVER_NOVO, e a falta lançada pelo professor é sobrescrita.
     *
     * O que o descarte evita é o caso PIOR: duas linhas degradadas colidindo
     * entre si na mesma chave (o `1|||RA|data` do teste de colisão em
     * `chaveNaturalFrequencia.test.ts`), onde uma some do índice e a outra pode
     * casar com a aula ERRADA. Chave inexistente é ruim; chave que aponta para
     * a aula de outro professor é pior.
     *
     * A proteção de verdade para este caso é `semChave > 0` virar suspeita no
     * sinal de cruzamento (P0-5) — está registrado em docs/TODO.md, não foi
     * feito aqui.
     */
    const idTurmaDisc = pick(row, 'ID_TURMADISC', 'IDTURMADISC');
    const idHorarioTurma = pick(row, 'ID_HORARIO_TURMA', 'IDHORARIOTURMA');
    if (!idTurmaDisc || !idHorarioTurma) {
      semChave += 1;
      logger.warn(
        {
          ra,
          data,
          idTurmaDisc: idTurmaDisc ?? '(vazio)',
          idHorarioTurma: idHorarioTurma ?? '(vazio)',
        },
        'Frequência sem componente da chave natural — descartada. A coluna existe no result ' +
          'set, mas veio vazia nesta linha; seguir com segmento vazio faria a chave casar com ' +
          'a aula errada',
      );
      continue;
    }

    faltas.push({
      codColigada: pick(row, 'CODCOLIGADA') ?? String(cfg.rm.escopo.coligada),
      ra,
      idTurmaDisc,
      data,
      idHorarioTurma,
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
      semChave,
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
    semChave,
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

/**
 * A chave natural desta falta, montada pela MESMA função que a projeção usa.
 *
 * ─── POR QUE ISTO NÃO PODE SER UMA SEGUNDA IMPLEMENTAÇÃO ────────────────────
 *
 * A decisão de escrever cruza dois lados: o que o Toddle quer escrever (chave
 * montada por `chaveNaturalRm` a partir de `LinhaFrequencia`) e o que o RM já tem
 * (chave montada aqui a partir de `RmFalta`). Se as duas fórmulas divergirem —
 * uma vírgula, uma ordem de campo, um `codColigada` como `"1"` contra `1` — o
 * cruzamento não casa NADA.
 *
 * E o modo de falha é o pior possível: tudo aparece como `ESCREVER_NOVO`, a
 * proteção contra sobrescrever lançamento humano **se desliga em silêncio**, e o
 * relatório fica bonito. Por isso não há duas fórmulas: há uma, chamada dos dois
 * lados.
 */
export function chaveNaturalDeFalta(f: RmFalta): string {
  return chaveNaturalRm({
    codColigada: Number(f.codColigada),
    idHorarioTurma: f.idHorarioTurma,
    idTurmaDisc: f.idTurmaDisc,
    ra: f.ra,
    data: f.data,
    presenca: f.presenca,
  });
}

/**
 * Traduz uma falta lida do RM no estado que a decisão de escrita espera.
 *
 * A autoria vai DERIVADA (`autoriaEhIntegracao`, `tocadaDepoisDeCriada`) e nunca
 * como login: `CRIADO_POR` traz CPF de professor, e este módulo já o descarta na
 * leitura. Ver a nota em `EstadoNoRm`.
 */
export function estadoNoRmDeFalta(f: RmFalta): EstadoNoRm {
  return {
    valor: f.presenca,
    autoriaEhIntegracao: f.criadoPelaIntegracao,
    tocadaDepoisDeCriada: f.alteradaDepoisDeCriada,
  };
}

/** Índice das faltas do RM por chave natural, para o cruzamento em lote. */
export function indexaFaltasPorChave(faltas: RmFalta[]): Map<string, RmFalta> {
  const m = new Map<string, RmFalta>();
  for (const f of faltas) m.set(chaveNaturalDeFalta(f), f);
  return m;
}
