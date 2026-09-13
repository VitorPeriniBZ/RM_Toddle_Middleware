import { chaveCourse, lerChaveCourse, pareceChaveLegada } from './chaveCourse';

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
 * ─── UMA LINHA NUNCA CAI NOS DOIS ÍNDICES ───────────────────────────────────
 *
 * A legada é só dígitos e a natural tem três partes não vazias separadas por
 * `:` — validadas por `lerChaveCourse`, não por "contém dois-pontos". O que não
 * é nem uma nem outra vai para o balde `desconhecida`, que existe para APARECER:
 * as 12 linhas arquivadas usam `rm_code = CODTURMA` (`EAVHS10IA`), de um modelo
 * anterior, e adivinhar o que elas significam seria pior que contá-las.
 *
 * O que PODE acontecer é a mesma turma ter duas linhas, uma em cada convenção.
 * Se elas apontarem para cursos diferentes, o resolvedor LANÇA — ver a nota
 * dentro de `resolver`.
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
    // `lerChaveCourse`, e não "contém dois-pontos": `2026::HS0001` e
    // `2026:EAVHS10IA` contêm o separador e NÃO são chaves válidas. Aceitá-las
    // como naturais encheria o índice de chaves que nunca casam e esvaziaria o
    // balde `desconhecida`, que é justamente o sinal de que há linha torta.
    if (lerChaveCourse(l.rmCode)) {
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
    const legada = porIdTurmaDisc.get(td.idTurmaDisc);

    // ─── AS DUAS RESPONDENDO DIFERENTE É ERRO, NÃO PREFERÊNCIA ─────────────
    //
    // Preferir a natural em silêncio parece a escolha segura, e não é: se a
    // linha natural estiver errada, o professor é vinculado à turma errada — e
    // preferir a legada recria o defeito da renumeração. Não há resposta certa
    // a escolher aqui, porque o dado está contraditório, e a única saída que
    // não inventa uma verdade é parar.
    //
    // Numa migração atômica isto não acontece: cada turma tem UMA linha. Se
    // acontecer, é duplicata de de-para, e quem tem de resolver é gente.
    if (natural && legada && natural !== legada) {
      throw new Error(
        `De-para COURSE contraditório para a turma-disciplina ${td.idTurmaDisc} ` +
          `(${td.codTurma}/${td.codDisc}): a chave natural aponta para o curso ${natural} e a ` +
          `chave antiga IDTURMADISC aponta para ${legada}. São dois mapeamentos para a mesma ` +
          'turma, apontando para cursos diferentes no Toddle — escolher um seria inventar uma ' +
          'resposta. Apague a linha errada na id_mapping antes de rodar de novo.',
      );
    }

    if (natural) return { toddleId: natural, convencao: 'natural' };
    if (legada) return { toddleId: legada, convencao: 'legada' };
    return { toddleId: null, convencao: null };
  };

  return Object.assign(resolver, { retrato });
}

/**
 * O de-para cobriu o escopo? Devolve o motivo da falha, ou `null` se está bem.
 *
 * ─── POR QUE ESTA REGRA É CATEGÓRICA, E NÃO UM PERCENTUAL ───────────────────
 *
 * Uma turma sem COURSE no Toddle é pendência NORMAL: a secretaria criou a turma
 * no RM e ela ainda não foi criada lá. Falhar o job por causa de uma deixaria o
 * fluxo vermelho por dias, e um alarme que fica sempre aceso não é alarme.
 *
 * TODAS sem COURSE é outra coisa: é o de-para inteiro sem casar. Nenhum
 * calendário escolar produz isso — só um erro de chave, de escopo ou de banco.
 *
 * Por isso o limiar é "nenhuma", e não "mais de X%": não há percentual
 * defensável entre os dois casos, e inventar um seria escolher um número para
 * parecer rigoroso. "Não resolveu nada" nunca é um estado legítimo.
 *
 * ─── O DEFEITO QUE ISTO FECHA ───────────────────────────────────────────────
 *
 * Em 11/09/2026 o sync de professores resolveu 0 de 186, criou 0 vínculos e
 * terminou como SUCESSO — o único critério de falha era exceção lançada. Uma
 * falha total lida como um dia normal, e ninguém tinha motivo para olhar. É o
 * mesmo padrão da DLQ que acumulou 62 jobs sem ninguém notar: o dano não é o
 * erro, é o silêncio.
 */
export function falhaDeCoberturaDoDePara(
  mapeadas: number,
  naoMapeadas: number,
  retrato: RetratoDoDePara,
): string | null {
  // ─── ZERO EM ESCOPO É LEITURA FALHA, NÃO ESCOPO VAZIO ─────────────────────
  //
  // Esta guarda nasceu hoje e tinha um buraco do tamanho do defeito que ela
  // existe para pegar: quando o RM devolve ZERO turma-disciplina, `naoMapeadas`
  // também é zero, a guarda devolvia `null` e o job terminava SUCCEEDED com
  // tudo zerado — o mesmo "0 de 186 e verde", só que uma camada acima.
  //
  // Uma escola em atividade sempre tem turma-disciplina. Zero significa Sentença
  // apagada, credencial expirada, escopo errado ou leitura que virou lista vazia
  // — nunca "não há turmas hoje".
  if (mapeadas === 0 && naoMapeadas === 0) {
    return (
      'O RM não devolveu NENHUMA turma-disciplina em escopo. Isso não é escopo vazio: uma ' +
      'escola em atividade sempre tem turma-disciplina. Suspeite da Sentença TODDLE.TURMADISC ' +
      '(apagada ou renomeada), da credencial do RM (a senha já expirou antes, code FE005) e do ' +
      'RM_CODFILIAL. Terminar como sucesso aqui esconderia uma integração parada.'
    );
  }

  if (naoMapeadas === 0) return null;
  if (mapeadas > 0) return null;
  return (
    `O de-para COURSE não resolveu NENHUMA das ${naoMapeadas} turma-disciplina em escopo. ` +
    'Isso não é uma turma faltando no Toddle: é o de-para inteiro sem casar. ' +
    `Convenções presentes na id_mapping: ${JSON.stringify(retrato)}. ` +
    'Confira a convenção de chave do COURSE antes de qualquer outra coisa.'
  );
}
