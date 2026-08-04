import { logger } from '@rm-toddle/config';
import type { ToddleBellSchedule } from '@rm-toddle/integrations';
import { normalizaHora } from './rmAttendanceTargets';

/**
 * De onde vem a HORA de uma aula lançada no Toddle.
 *
 * Descoberto no shadow mode em 04/08/2026, e ao contrário do que eu supunha: o
 * `startTime`/`endTime` do registro de frequência vem NULO — 800 de 800 na
 * amostra. A hora existe só no `periodSet` do bell schedule, que liga
 * `periodId` a `startTime`/`endTime`.
 *
 * E ela não é unívoca: o MESMO periodId aparece em bell schedules diferentes com
 * horas diferentes (9 dos 57 medidos; um deles em 4 faixas). O registro de
 * frequência não diz qual bell schedule vale. Portanto `periodId` sozinho NÃO
 * determina a hora, e este índice devolve ambiguidade em vez de escolher.
 *
 * A saída disso é o de-para explícito: períodos criados a partir da grade do RM,
 * com sourceId próprio, onde a relação é 1:1 por construção.
 */

export interface FaixaPeriodo {
  horaInicial: string;
  horaFinal: string;
}

export class PeriodTimeIndex {
  private constructor(
    private readonly porPeriodo: Map<string, FaixaPeriodo[]>,
    readonly totalPeriodos: number,
    readonly ambiguos: string[],
    /** Faixas distintas vistas no Toddle — para comparar com as do RM. */
    readonly faixas: string[],
    readonly bellSchedules: Array<{ label: string; curriculumId: string; periodos: number }>,
  ) {}

  static deBellSchedules(schedules: ToddleBellSchedule[]): PeriodTimeIndex {
    const acumulado = new Map<string, Map<string, FaixaPeriodo>>();
    const resumoGrades: Array<{ label: string; curriculumId: string; periodos: number }> = [];

    for (const bs of schedules) {
      resumoGrades.push({
        label: String(bs.label ?? '(sem rótulo)'),
        curriculumId: String(bs.curriculumId ?? ''),
        periodos: bs.periodSet?.length ?? 0,
      });

      for (const item of bs.periodSet ?? []) {
        const horaInicial = normalizaHora(item.startTime ?? null);
        const horaFinal = normalizaHora(item.endTime ?? null);
        if (!horaInicial || !horaFinal) continue;

        const chave = `${horaInicial}-${horaFinal}`;
        const atual = acumulado.get(item.periodId) ?? new Map<string, FaixaPeriodo>();
        atual.set(chave, { horaInicial, horaFinal });
        acumulado.set(item.periodId, atual);
      }
    }

    const porPeriodo = new Map<string, FaixaPeriodo[]>();
    const ambiguos: string[] = [];
    const faixas = new Set<string>();

    for (const [periodId, variantes] of acumulado) {
      const lista = [...variantes.values()];
      porPeriodo.set(periodId, lista);
      if (lista.length > 1) ambiguos.push(periodId);
      for (const v of lista) faixas.add(`${v.horaInicial}-${v.horaFinal}`);
    }

    logger.info(
      {
        bellSchedules: schedules.length,
        periodosComHora: porPeriodo.size,
        periodosAmbiguos: ambiguos.length,
        faixasDistintas: faixas.size,
      },
      'Índice de horas por periodId construído a partir dos bell schedules',
    );

    return new PeriodTimeIndex(porPeriodo, porPeriodo.size, ambiguos, [...faixas].sort(), resumoGrades);
  }

  /**
   * Hora de início de um período.
   *
   * `null`      → o periodId não tem hora em nenhum bell schedule.
   * `{ambiguo}` → tem mais de uma hora, e nada no registro de frequência diz
   *               qual bell schedule vale. Recusa, não escolha.
   */
  resolve(periodId: string): { faixa: FaixaPeriodo } | { ambiguo: FaixaPeriodo[] } | null {
    const faixas = this.porPeriodo.get(periodId);
    if (!faixas?.length) return null;
    if (faixas.length > 1) return { ambiguo: faixas };
    return { faixa: faixas[0] };
  }

  /** Índice vazio, para quando não há bell schedule nenhum. */
  static vazio(): PeriodTimeIndex {
    return new PeriodTimeIndex(new Map(), 0, [], [], []);
  }
}
