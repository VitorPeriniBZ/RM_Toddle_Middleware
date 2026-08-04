import { env, logger } from '@rm-toddle/config';
import { wsDataServerClient } from '@rm-toddle/integrations';

/**
 * Os alvos que uma frequência precisa acertar no RM: IDHORARIOTURMA e CODETAPA.
 *
 * Levantado e verificado em 04/08/2026 (ver
 * docs/rm-dataservers/EduFrequenciaDiariaWSData.md). Os dois números que
 * sustentam este módulo:
 *
 *   - (IDTURMADISC, DIASEMANA, faixa de horário) deu 518 chaves para 518
 *     horários. É ÚNICO, então não há inferência: ou resolve exatamente um
 *     IDHORARIOTURMA, ou recusa.
 *   - Filtrando TIPOETAPA='F' AND PERMITEDIGITACAO='S' sobram 3 etapas por
 *     turma-disciplina com janelas DISJUNTAS. Fora desse filtro entra a etapa
 *     "Total Faltas", que é calculada e cobre o ano inteiro — e sobrepõe todas.
 *
 * Este módulo NÃO escreve nada. Ele só descreve o que o RM aceitaria.
 */

/** Um horário da grade: uma aula semanal de uma turma-disciplina. */
export interface RmHorario {
  idHorarioTurma: string;
  idTurmaDisc: string;
  /** '2'=segunda … '6'=sexta, convenção do RM. */
  diaSemana: string;
  /** "HH:MM" normalizado. */
  horaInicial: string;
  horaFinal: string;
  /** Vigência; pode ser nula em alguns registros (8 dos 518 medidos). */
  dataInicial: string | null;
  dataFinal: string | null;
  codHor: string | null;
}

/** Uma etapa de FALTA que aceita digitação. */
export interface RmEtapaFalta {
  idTurmaDisc: string;
  codEtapa: string;
  dtInicio: string;
  dtFim: string;
  /** Frequência mínima da etapa (75,00 na EAV). Informativo. */
  freqMin: string | null;
}

const DIAS_UTEIS = new Set(['2', '3', '4', '5', '6']);

/** "8:00:00", "08:00" e "8:00" → "08:00". Devolve null para vazio/"null". */
export function normalizaHora(valor: string | null | undefined): string | null {
  if (valor == null) return null;
  const bruto = String(valor).trim();
  if (bruto === '' || bruto.toLowerCase() === 'null') return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(bruto);
  if (!m) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/** "2026-03-02T00:00:00" → "2026-03-02". Devolve null para vazio. */
function soData(valor: string | null | undefined): string | null {
  if (valor == null) return null;
  const bruto = String(valor).trim();
  if (bruto === '' || bruto.toLowerCase() === 'null') return null;
  const iso = bruto.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

/**
 * Dia da semana do RM a partir de "YYYY-MM-DD".
 *
 * Construído com UTC de propósito: `new Date('2026-03-02')` já é interpretado
 * como UTC, e usar getDay() (local) faria a data escorregar um dia em fusos
 * negativos como o do Brasil. Um dia errado aqui resolve a AULA errada.
 */
export function diaSemanaRm(dataIso: string): string | null {
  const d = new Date(`${dataIso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const rm = String(d.getUTCDay() + 1); // domingo=0 no JS, =1 no RM
  return DIAS_UTEIS.has(rm) ? rm : null;
}

export const chaveHorario = (idTurmaDisc: string, diaSemana: string, horaInicial: string): string =>
  `${idTurmaDisc}|${diaSemana}|${horaInicial}`;

/**
 * Índice consultável dos alvos do RM. Construído uma vez por execução, a partir
 * de duas leituras (horários e etapas) — não uma chamada por registro.
 */
export class RmAttendanceTargets {
  private constructor(
    /** chave → horários que casam. Mais de um = ambíguo, e a projeção recusa. */
    private readonly horariosPorChave: Map<string, RmHorario[]>,
    private readonly etapasPorTurmaDisc: Map<string, RmEtapaFalta[]>,
    readonly totalHorarios: number,
    readonly totalEtapas: number,
    /** Faixas distintas encontradas, para o relatório do shadow mode. */
    readonly faixas: string[],
  ) {}

  /**
   * Lê o RM e monta o índice, restrito às turmas-disciplina em escopo.
   *
   * O recorte por IDTURMADISC é interseção POSITIVA: passamos a lista do que
   * está mapeado, e o que não estiver simplesmente não entra no índice. Não há
   * caminho em que "lista vazia" signifique "tudo".
   */
  static async carregar(idsTurmaDisc: string[], codFilial: string): Promise<RmAttendanceTargets> {
    if (idsTurmaDisc.length === 0) {
      throw new Error(
        'RmAttendanceTargets.carregar recebeu lista vazia de turma-disciplina. ' +
          'Sem escopo não há projeção possível — isto é recusa, não "carregar tudo".',
      );
    }

    const emEscopo = new Set(idsTurmaDisc);
    const lista = [...emEscopo].join(',');

    // O ReadView de SHorarioTurma NÃO aceita filtrar por IDPERLET (devolve
    // "Invalid column name"), mesmo devolvendo o campo em cada linha. Filtramos
    // por filial no RM e por turma-disciplina aqui.
    const horariosBrutos = await wsDataServerClient.readView(
      'EduHorarioTurmaData',
      `SHorarioTurma.CODFILIAL=${codFilial}`,
      'SHorarioTurma',
      codFilial,
    );

    const horariosPorChave = new Map<string, RmHorario[]>();
    const faixas = new Set<string>();
    let totalHorarios = 0;

    for (const row of horariosBrutos) {
      const idTurmaDisc = row.IDTURMADISC;
      if (!emEscopo.has(idTurmaDisc)) continue;

      const horaInicial = normalizaHora(row.HORAINICIAL);
      const horaFinal = normalizaHora(row.HORAFINAL);
      const diaSemana = row.DIASEMANA;
      if (!horaInicial || !horaFinal || !DIAS_UTEIS.has(diaSemana)) {
        logger.warn(
          { idHorarioTurma: row.IDHORARIOTURMA, idTurmaDisc, diaSemana, hora: row.HORAINICIAL },
          'Horário do RM sem dia/hora utilizável — fora do índice',
        );
        continue;
      }

      const horario: RmHorario = {
        idHorarioTurma: row.IDHORARIOTURMA,
        idTurmaDisc,
        diaSemana,
        horaInicial,
        horaFinal,
        dataInicial: soData(row.DATAINICIAL),
        dataFinal: soData(row.DATAFINAL),
        codHor: row.CODHOR ?? null,
      };

      const chave = chaveHorario(idTurmaDisc, diaSemana, horaInicial);
      const atual = horariosPorChave.get(chave);
      if (atual) atual.push(horario);
      else horariosPorChave.set(chave, [horario]);

      faixas.add(`${horaInicial}-${horaFinal}`);
      totalHorarios += 1;
    }

    // Etapas: SEtapas não tem CODFILIAL, o recorte vem do IN de IDTURMADISC.
    // ATENÇÃO ao elemento-linha 'SEtapas' em case misto — 'SETAPAS' devolve zero
    // linhas sem erro, o que parece tabela vazia.
    const etapasBrutas = await wsDataServerClient.readView(
      'EduEtapasData',
      `SETAPAS.CODCOLIGADA=${env.RM_CODCOLIGADA} AND SETAPAS.IDTURMADISC IN (${lista})`,
      'SEtapas',
      codFilial,
    );

    const etapasPorTurmaDisc = new Map<string, RmEtapaFalta[]>();
    let totalEtapas = 0;

    for (const row of etapasBrutas) {
      const idTurmaDisc = row.IDTURMADISC;
      if (!emEscopo.has(idTurmaDisc)) continue;
      // O filtro que importa. Sem PERMITEDIGITACAO entra a etapa "Total Faltas",
      // que é calculada, cobre o ano inteiro e sobrepõe as três dos trimestres.
      if (row.TIPOETAPA !== 'F' || row.PERMITEDIGITACAO !== 'S') continue;

      const dtInicio = soData(row.DTINICIO);
      const dtFim = soData(row.DTFIM);
      if (!dtInicio || !dtFim) {
        logger.warn({ idTurmaDisc, codEtapa: row.CODETAPA }, 'Etapa de falta sem vigência — ignorada');
        continue;
      }

      const etapa: RmEtapaFalta = {
        idTurmaDisc,
        codEtapa: row.CODETAPA,
        dtInicio,
        dtFim,
        freqMin: row.FREQMIN ?? null,
      };
      const atual = etapasPorTurmaDisc.get(idTurmaDisc);
      if (atual) atual.push(etapa);
      else etapasPorTurmaDisc.set(idTurmaDisc, [etapa]);
      totalEtapas += 1;
    }

    logger.info(
      {
        turmaDiscEmEscopo: emEscopo.size,
        horariosNoIndice: totalHorarios,
        etapasGravaveis: totalEtapas,
        faixasDistintas: faixas.size,
        semHorario: [...emEscopo].filter(
          (id) => ![...horariosPorChave.values()].flat().some((h) => h.idTurmaDisc === id),
        ).length,
      },
      'Índice de alvos do RM carregado',
    );

    return new RmAttendanceTargets(
      horariosPorChave,
      etapasPorTurmaDisc,
      totalHorarios,
      totalEtapas,
      [...faixas].sort(),
    );
  }

  /**
   * Resolve o IDHORARIOTURMA de uma aula.
   *
   * Devolve `{ ambiguo: true }` em vez de escolher quando mais de um horário
   * casa. A medição diz que isso não acontece hoje (518 chaves para 518
   * horários), mas "não acontece hoje" não é invariante — grade muda.
   *
   * A vigência do horário é conferida quando existe; quando é nula (8 casos
   * medidos) não bloqueia, porque a chave já é única sem ela.
   */
  resolveHorario(
    idTurmaDisc: string,
    dataIso: string,
    horaInicial: string,
  ): { horario: RmHorario } | { ambiguo: RmHorario[] } | null {
    const dia = diaSemanaRm(dataIso);
    if (!dia) return null;

    const candidatos = this.horariosPorChave.get(chaveHorario(idTurmaDisc, dia, horaInicial));
    if (!candidatos?.length) return null;

    const vigentes = candidatos.filter(
      (h) =>
        (h.dataInicial === null || h.dataInicial <= dataIso) &&
        (h.dataFinal === null || dataIso <= h.dataFinal),
    );
    const efetivos = vigentes.length > 0 ? vigentes : [];
    if (efetivos.length === 0) return null;
    if (efetivos.length > 1) return { ambiguo: efetivos };
    return { horario: efetivos[0] };
  }

  /**
   * Resolve o CODETAPA pela data. Recusa quando nenhuma etapa cobre a data
   * (medimos 202 aulas assim, em 07 e 08/09) e quando mais de uma cobre
   * (medimos 1 turma assim: IDTURMADISC 1256, EAVHS11IA / Matemática).
   */
  resolveEtapa(
    idTurmaDisc: string,
    dataIso: string,
  ): { etapa: RmEtapaFalta } | { ambiguo: RmEtapaFalta[] } | null {
    const etapas = this.etapasPorTurmaDisc.get(idTurmaDisc);
    if (!etapas?.length) return null;

    const cobrem = etapas.filter((e) => e.dtInicio <= dataIso && dataIso <= e.dtFim);
    if (cobrem.length === 0) return null;
    if (cobrem.length > 1) return { ambiguo: cobrem };
    return { etapa: cobrem[0] };
  }

  /** Turmas-disciplina do escopo que ficaram sem nenhum horário no índice. */
  turmaDiscSemHorario(idsTurmaDisc: string[]): string[] {
    const comHorario = new Set(
      [...this.horariosPorChave.values()].flat().map((h) => h.idTurmaDisc),
    );
    return idsTurmaDisc.filter((id) => !comHorario.has(id));
  }
}
