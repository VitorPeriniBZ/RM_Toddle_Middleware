import { chaveCourse, pareceChaveLegada } from './chaveCourse';

/**
 * Resolve o COURSE do Toddle a partir de uma turma-disciplina do RM, aceitando
 * as DUAS convenções de `rm_code` ao mesmo tempo.
 *
 * ─── POR QUE ISTO EXISTE ────────────────────────────────────────────────────
 *
 * A chave do de-para COURSE mudou de `IDTURMADISC` (identity do RM) para
 * `CODPERLET:CODTURMA:CODDISC` (chave natural), porque a identity é renumerada
 * numa cópia de base e o vínculo passaria a apontar para OUTRA disciplina em
 * silêncio.
 *
 * O leitor foi trocado antes do dado. Resultado medido em produção: 198 linhas
 * COURSE, ZERO na convenção nova, e o sync de professores relatando
 * `turmas_nao_mapeadas: 186` — e terminando como SUCESSO, com 0 vínculos. Uma
 * falha total lida como um dia normal.
 *
 * ─── EXPAND ANTES DE MIGRAR, E NÃO O CONTRÁRIO ──────────────────────────────
 *
 * A ordem certa é: (1) todo leitor aceita as duas convenções, (2) o dado migra,
 * (3) a tolerância sai. Foi o passo (1) que faltou, e é o que este módulo é.
 *
 * Migrar o dado AGORA não seria a correção: consertaria professores e quebraria
 * a via de nota no mesmo movimento, porque os consumidores que escrevem no RM
 * ainda usam o `rm_code` como `IDTURMADISC` cru — a consulta viraria
 * `IDTURMADISC IN (2026:EAVHS10IA:HS0001)`. Com a tolerância no lugar, o dado
 * pode migrar depois, sem janela em que algo fique quebrado.
 *
 * ─── A AMBIGUIDADE É IMPOSSÍVEL, NÃO IMPROVÁVEL ─────────────────────────────
 *
 * As duas convenções não se confundem: a legada é só dígitos, a natural tem
 * dois-pontos, e `chaveCourse` RECUSA parte vazia ou com `:` embutido. Então
 * cada linha do de-para pertence a exatamente um dos dois índices, e um
 * `rm_code` jamais casa nos dois.
 */

export interface LinhaDeParaCourse {
  rmCode: string;
  toddleId: string;
}

/** O bastante para montar as duas chaves. */
export interface TurmaDiscDoRm {
  idTurmaDisc: string;
  codTurma: string;
  codDisc: string;
}

export type ConvencaoCourse = 'natural' | 'legada';

export interface ResolucaoCourse {
  toddleId: string | null;
  /** Qual índice respondeu. `null` quando não achou. */
  convencao: ConvencaoCourse | null;
}

/** Quantas linhas do de-para estão em cada convenção. Para log e para a tela. */
export interface RetratoDoDePara {
  natural: number;
  legada: number;
  /** Nem uma coisa nem outra — não deveria existir, e por isso é contado. */
  desconhecida: number;
}

export interface ResolvedorDeCourse {
  (td: TurmaDiscDoRm): ResolucaoCourse;
  readonly retrato: RetratoDoDePara;
}

/**
 * Monta o resolvedor.
 *
 * A chave natural é tentada PRIMEIRO: terminada a migração, a legada some
 * sozinha, e nenhuma linha nova jamais cai no caminho antigo.
 */
export function criarResolvedorDeCourse(
  linhas: readonly LinhaDeParaCourse[],
  periodoLetivo: string,
): ResolvedorDeCourse {
  if (!periodoLetivo.trim()) {
    throw new Error(
      'periodoLetivo vazio: é parte da chave natural do COURSE e sem ele nenhuma turma resolve.',
    );
  }

  const porChaveNatural = new Map<string, string>();
  const porIdTurmaDisc = new Map<string, string>();
  const retrato: RetratoDoDePara = { natural: 0, legada: 0, desconhecida: 0 };

  for (const l of linhas) {
    if (l.rmCode.includes(':')) {
      porChaveNatural.set(l.rmCode, l.toddleId);
      retrato.natural += 1;
    } else if (pareceChaveLegada(l.rmCode)) {
      porIdTurmaDisc.set(l.rmCode, l.toddleId);
      retrato.legada += 1;
    } else {
      // Nem dígitos nem chave natural: alguma terceira convenção. Não se
      // adivinha o que ela significa — conta-se, para aparecer no log.
      retrato.desconhecida += 1;
    }
  }

  const resolver = (td: TurmaDiscDoRm): ResolucaoCourse => {
    const natural = porChaveNatural.get(chaveCourse(periodoLetivo, td.codTurma, td.codDisc));
    if (natural) return { toddleId: natural, convencao: 'natural' };

    const legada = porIdTurmaDisc.get(td.idTurmaDisc);
    if (legada) return { toddleId: legada, convencao: 'legada' };

    return { toddleId: null, convencao: null };
  };

  return Object.assign(resolver, { retrato });
}
