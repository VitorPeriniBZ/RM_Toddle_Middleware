import type { ToddleAttendance } from '@rm-toddle/integrations';
import { normalizaHora, type RmAttendanceTargets } from './rmAttendanceTargets';
import type { PeriodTimeIndex } from './periodTimeIndex';

/**
 * Projeta um registro de frequência do Toddle no que o RM aceitaria — e SÓ isso.
 * Nada aqui grava, nem no RM, nem no nosso banco.
 *
 * A regra de autorização é INTERSEÇÃO POSITIVA: um registro só é projetável se
 * TODOS os elos existem e estão ativos. Não existe "não é demo, então vai".
 * O tenant do Toddle tem 86.519 registros de frequência de DEMONSTRAÇÃO contra
 * 253 alunos reais; qualquer critério por exclusão erra na direção do estrago.
 *
 * Toda recusa é tipada e contada. Recusa silenciosa é pior que erro.
 */

/** Motivos de recusa. A ordem da avaliação é a ordem desta lista. */
export type MotivoRecusa =
  /** O Toddle marcou o registro como excluído. É revogação no LMS, não escrita no RM. */
  | 'EXCLUIDO_NO_TODDLE'
  /** Chamada de homeroom (masterAttendance): vem sem curso. Sem curso não há IDTURMADISC. */
  | 'SEM_CURSO_NA_ORIGEM'
  | 'SEM_ALUNO_NA_ORIGEM'
  /** Nem startTime nem periodId: não há por onde chegar à hora da aula. */
  | 'SEM_HORA_NA_ORIGEM'
  /** Tem periodId, mas nenhum bell schedule dá hora a ele. */
  | 'PERIODO_SEM_HORA'
  /** O periodId aparece em bell schedules diferentes com horas diferentes. */
  | 'PERIODO_AMBIGUO'
  /** courseId do Toddle não tem mapeamento COURSE ativo — provavelmente demo. */
  | 'CURSO_NAO_MAPEADO'
  | 'ALUNO_NAO_MAPEADO'
  /** Não existe horário no RM para essa turma-disciplina naquele dia e hora. */
  | 'HORARIO_NAO_ENCONTRADO'
  | 'HORARIO_AMBIGUO'
  /** A data não cai em nenhuma etapa de falta gravável (ex.: 07-08/09). */
  | 'ETAPA_NAO_ENCONTRADA'
  /** Mais de uma etapa cobre a data (ex.: IDTURMADISC 1256). */
  | 'ETAPA_AMBIGUA'
  /** O código de chamada do Toddle não tem política definida para PRESENCA. */
  | 'OPCAO_SEM_POLITICA';

export interface LinhaFrequencia {
  codColigada: number;
  idHorarioTurma: string;
  idTurmaDisc: string;
  ra: string;
  /** "YYYY-MM-DD". A serialização para dateTime SEM FUSO acontece no XML. */
  data: string;
  presenca: string;
  justificada?: string;
}

export interface Projetado {
  status: 'projetado';
  /** id do registro no Toddle, para rastreio. */
  origemId: string;
  linha: LinhaFrequencia;
  /** Vai no PARAMS, agrupado por turma-disciplina + etapa. */
  codEtapa: string;
  /** Chave natural do RM — é por ela que deduplicamos. */
  chaveRm: string;
}

export interface Recusado {
  status: 'recusado';
  origemId: string;
  motivo: MotivoRecusa;
  detalhe: string;
}

export type ResultadoProjecao = Projetado | Recusado;

/**
 * Política de tradução do código de chamada do Toddle para o RM.
 *
 * ─── ISTO NÃO ESTÁ VERIFICADO ───────────────────────────────────────────────
 *
 * `PRESENCA='A'` para ausência e `'P'` para presença vêm da documentação da
 * TOTVS, não de medição: o ReadView do DataServer de frequência usa filtro
 * posicional cuja gramática não descobrimos, então não foi possível ler nenhum
 * lançamento existente para confirmar o domínio.
 *
 * E o mapeamento de atraso / falta justificada é DECISÃO DA ESCOLA, não técnica:
 * reduzir "Late" a presença ou a ausência perde informação de qualquer lado. Até
 * haver política formal, essas opções são RECUSADAS — é o que o shadow mode
 * serve para expor.
 *
 * A chave é a abreviação em MAIÚSCULA; o label é conferido só no relatório.
 */
export const POLITICA_PRESENCA: Record<string, { presenca: string; justificada?: string }> = {
  P: { presenca: 'P' },
  A: { presenca: 'A' },
};

export const chaveNaturalRm = (l: LinhaFrequencia): string =>
  [l.codColigada, l.idHorarioTurma, l.idTurmaDisc, l.ra, l.data].join('|');

export interface ContextoProjecao {
  codColigada: number;
  /** courseId do Toddle → IDTURMADISC. Só mapeamentos ATIVOS entram. */
  cursoParaTurmaDisc: Map<string, string>;
  /** studentId do Toddle → RA. Só mapeamentos ATIVOS entram. */
  alunoParaRa: Map<string, string>;
  alvos: RmAttendanceTargets;
  /** periodId → hora, dos bell schedules. É daqui que a hora vem na prática. */
  periodos: PeriodTimeIndex;
}

/** Normaliza id do Toddle: a API mistura number e string no mesmo campo. */
const id = (valor: unknown): string | null => {
  if (valor == null) return null;
  const s = String(valor).trim();
  return s === '' || s === 'null' ? null : s;
};

export function projetaRegistro(
  registro: ToddleAttendance,
  ctx: ContextoProjecao,
): ResultadoProjecao {
  const origemId = id(registro.id) ?? '(sem id)';
  const recusa = (motivo: MotivoRecusa, detalhe: string): Recusado => ({
    status: 'recusado',
    origemId,
    motivo,
    detalhe,
  });

  if (registro.isDeleted === true) {
    return recusa(
      'EXCLUIDO_NO_TODDLE',
      'isDeleted=true. No RM isso seria alteração de registro acadêmico, que passa por aprovação — ' +
        'nunca consequência automática de exclusão no LMS.',
    );
  }

  const courseId = id(registro.courseId);
  if (!courseId) {
    return recusa(
      'SEM_CURSO_NA_ORIGEM',
      'courseId nulo (chamada de homeroom/masterAttendance). Sem curso não existe IDTURMADISC.',
    );
  }

  const studentId = id(registro.studentId);
  if (!studentId) return recusa('SEM_ALUNO_NA_ORIGEM', 'studentId nulo.');

  // A hora quase nunca vem no registro (medido: nula em 800 de 800). O caminho
  // real é periodId -> bell schedule. O startTime, quando existe, tem prioridade
  // porque é mais específico que a grade.
  const periodId = id(registro.periodId);
  let horaInicial = normalizaHora(registro.startTime ?? null);

  if (!horaInicial) {
    if (!periodId) {
      return recusa(
        'SEM_HORA_NA_ORIGEM',
        `startTime=${JSON.stringify(registro.startTime)} e periodId nulo — não há por onde ` +
          'chegar à hora da aula.',
      );
    }
    const faixa = ctx.periodos.resolve(periodId);
    if (faixa === null) {
      return recusa(
        'PERIODO_SEM_HORA',
        `periodId ${periodId} não tem hora em nenhum bell schedule. Enquanto a grade do campus ` +
          'não existir no Toddle, não há como saber a que aula do RM isso corresponde.',
      );
    }
    if ('ambiguo' in faixa) {
      return recusa(
        'PERIODO_AMBIGUO',
        `periodId ${periodId} tem ${faixa.ambiguo.length} horas diferentes em bell schedules ` +
          `distintos (${faixa.ambiguo.map((f) => `${f.horaInicial}-${f.horaFinal}`).join(', ')}) ` +
          'e o registro não diz qual grade vale.',
      );
    }
    horaInicial = faixa.faixa.horaInicial;
  }

  const idTurmaDisc = ctx.cursoParaTurmaDisc.get(courseId);
  if (!idTurmaDisc) {
    return recusa(
      'CURSO_NAO_MAPEADO',
      `courseId ${courseId} não tem mapeamento COURSE ativo — fora de escopo ou registro de demonstração.`,
    );
  }

  const ra = ctx.alunoParaRa.get(studentId);
  if (!ra) {
    return recusa(
      'ALUNO_NAO_MAPEADO',
      `studentId ${studentId} não tem mapeamento STUDENT ativo — fora de escopo ou aluno de demonstração.`,
    );
  }

  const data = String(registro.date ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return recusa('SEM_HORA_NA_ORIGEM', `date inválida: ${JSON.stringify(registro.date)}`);
  }

  const horario = ctx.alvos.resolveHorario(idTurmaDisc, data, horaInicial);
  if (horario === null) {
    return recusa(
      'HORARIO_NAO_ENCONTRADO',
      `sem horário no RM para IDTURMADISC ${idTurmaDisc} em ${data} às ${horaInicial}.`,
    );
  }
  if ('ambiguo' in horario) {
    return recusa(
      'HORARIO_AMBIGUO',
      `${horario.ambiguo.length} horários casam (IDHORARIOTURMA ` +
        `${horario.ambiguo.map((h) => h.idHorarioTurma).join(', ')}). Não desempatar por conta própria.`,
    );
  }

  const etapa = ctx.alvos.resolveEtapa(idTurmaDisc, data);
  if (etapa === null) {
    return recusa(
      'ETAPA_NAO_ENCONTRADA',
      `${data} não cai em nenhuma etapa de falta gravável da IDTURMADISC ${idTurmaDisc}.`,
    );
  }
  if ('ambiguo' in etapa) {
    return recusa(
      'ETAPA_AMBIGUA',
      `${data} cai em ${etapa.ambiguo.length} etapas (CODETAPA ` +
        `${etapa.ambiguo.map((e) => e.codEtapa).join(', ')}) da IDTURMADISC ${idTurmaDisc}.`,
    );
  }

  const abrev = (registro.attendanceOption?.abbreviation ?? '').trim().toUpperCase();
  const politica = POLITICA_PRESENCA[abrev];
  if (!politica) {
    return recusa(
      'OPCAO_SEM_POLITICA',
      `opção "${registro.attendanceOption?.label ?? '?'}" (abreviação "${abrev}") não tem política ` +
        'de tradução para PRESENCA. Precisa de decisão da escola antes de virar lançamento.',
    );
  }

  const linha: LinhaFrequencia = {
    codColigada: ctx.codColigada,
    idHorarioTurma: horario.horario.idHorarioTurma,
    idTurmaDisc,
    ra,
    data,
    presenca: politica.presenca,
    ...(politica.justificada ? { justificada: politica.justificada } : {}),
  };

  return {
    status: 'projetado',
    origemId,
    linha,
    codEtapa: etapa.etapa.codEtapa,
    chaveRm: chaveNaturalRm(linha),
  };
}

export interface ResumoProjecao {
  lidos: number;
  projetados: Projetado[];
  recusados: Recusado[];
  porMotivo: Record<string, number>;
  /** Registros distintos do Toddle que colidem na MESMA chave natural do RM. */
  colisoes: Array<{ chaveRm: string; origemIds: string[] }>;
  /** Opções de chamada vistas na origem, com contagem — insumo para a política. */
  opcoesVistas: Record<string, number>;
}

/**
 * Projeta o lote inteiro e detecta colisão de chave natural.
 *
 * Deduplicar é NOSSA responsabilidade: o dataset do RM vem com
 * `EnforceConstraints="False"`, então ele não rejeita duas linhas com a mesma
 * PK. Colisão vai para revisão — nunca "vence o último".
 */
export function projetaLote(
  registros: ToddleAttendance[],
  ctx: ContextoProjecao,
): ResumoProjecao {
  const projetados: Projetado[] = [];
  const recusados: Recusado[] = [];
  const porMotivo: Record<string, number> = {};
  const opcoesVistas: Record<string, number> = {};
  const porChave = new Map<string, string[]>();

  for (const registro of registros) {
    const rotulo = registro.attendanceOption?.label ?? '(sem opção)';
    const abrev = registro.attendanceOption?.abbreviation ?? '?';
    const chaveOpcao = `${rotulo} [${abrev}]`;
    opcoesVistas[chaveOpcao] = (opcoesVistas[chaveOpcao] ?? 0) + 1;

    const resultado = projetaRegistro(registro, ctx);
    if (resultado.status === 'recusado') {
      recusados.push(resultado);
      porMotivo[resultado.motivo] = (porMotivo[resultado.motivo] ?? 0) + 1;
      continue;
    }

    projetados.push(resultado);
    const anteriores = porChave.get(resultado.chaveRm);
    if (anteriores) anteriores.push(resultado.origemId);
    else porChave.set(resultado.chaveRm, [resultado.origemId]);
  }

  const colisoes = [...porChave.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([chaveRm, origemIds]) => ({ chaveRm, origemIds }));

  return {
    lidos: registros.length,
    projetados,
    recusados,
    porMotivo,
    colisoes,
    opcoesVistas,
  };
}
