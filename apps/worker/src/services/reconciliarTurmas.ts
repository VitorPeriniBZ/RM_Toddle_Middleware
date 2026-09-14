import { logger, tenantConfig } from '@rm-toddle/config';
import { idMappingRepository } from '@rm-toddle/db';
import { chaveCourse, criarResolvedorDeCourse, fetchNotasFromRm } from '@rm-toddle/domain';
import { toddleClient, wsDataServerClient } from '@rm-toddle/integrations';

/** Config da escola atendida por este processo. */
const cfg = tenantConfig;

/**
 * TURMA E DISCIPLINA (RM → de-para): detectar a deriva, não corrigi-la.
 *
 * ─── POR QUE ESTE FLUXO NÃO ESCREVE ─────────────────────────────────────────
 *
 * Os 186 `COURSE` vieram de uma carga manual e nada os atualiza. Toda
 * turma-disciplina criada no RM depois daquele dia é invisível para a
 * integração — foi assim que a `1714` ficou de fora com 60 faltas lançadas, e só
 * apareceu por acidente ao cruzar frequência.
 *
 * A correção óbvia seria criar a turma no Toddle automaticamente. Não é o que
 * este fluxo faz, por uma razão que vale mais que a conveniência: **o Toddle não
 * tem DELETE de turma**, só arquivar. Uma turma criada por engano — porque o RM
 * abriu uma oferta que nunca foi enturmada, ou porque a cópia de base renumerou
 * algo — fica lá para sempre, aparecendo para professor e aluno. Criar é
 * irreversível; detectar não é.
 *
 * Então o que roda de hora em hora é a DETECÇÃO, e ela é barata. Quem decide
 * criar é gente, olhando a lista.
 *
 * ─── O QUE DERRUBA E O QUE NÃO DERRUBA ──────────────────────────────────────
 *
 * Deriva NÃO derruba o job. Turma nova no começo de semestre é o normal, e um
 * fluxo vermelho por dias ensina a ignorar a cor — alarme sempre aceso não é
 * alarme.
 *
 * O que derruba é a LEITURA estar quebrada: zero turma-disciplina vinda do RM,
 * ou nenhuma turma mapeada reconhecida. As duas significam que a resposta "não
 * há deriva" seria mentira, e "sem deriva" é exatamente o que alguém concluiria
 * de um verde. É a mesma regra categórica de `falhaDeCoberturaDoDePara`.
 */

export type Situacao =
  | 'OK'
  | 'NOVA_COM_ALUNOS'
  | 'NOVA_SEM_ALUNOS'
  | 'INATIVADA_NO_RM'
  | 'REATIVADA_NO_RM'
  | 'SUMIU_DO_RM';

/** As três que ninguém pode resolver sem decidir. */
export const EXIGEM_DECISAO: Situacao[] = ['NOVA_COM_ALUNOS', 'REATIVADA_NO_RM', 'SUMIU_DO_RM'];

export interface Achado {
  situacao: Situacao;
  idTurmaDisc: string;
  codTurma?: string;
  codDisc?: string;
  nomeDisc?: string;
  ativa?: string;
  alunos?: number;
  criadoEm?: string;
  alteradoEm?: string;
}

export interface RelatorioDeTurmas {
  idPerlet: string;
  /** Turma-disciplina lidas do RM, no campus. */
  lidasDoRm: number;
  /** … das quais, no período letivo corrente. É sobre estas que se decide. */
  doPeriodoCorrente: number;
  mapeadasAtivas: number;
  mapeadasArquivadas: number;
  achados: Achado[];
  porSituacao: Record<string, number>;
  /** Título no Toddle que não contém mais o nome da disciplina no RM. */
  renomeadas: Array<{ idTurmaDisc: string; noRm: string; noToddle: string }>;
  /** `true` quando a medição de alunos por turma não pôde ser feita. */
  semSinalDeAlunos: boolean;
}

/** Leitura impossível — ver "o que derruba" no cabeçalho. */
export class LeituraDeTurmasQuebrada extends Error {
  constructor(readonly comoResolver: string, mensagem: string) {
    super(mensagem);
    this.name = 'LeituraDeTurmasQuebrada';
  }
}

const soData = (v: string | undefined): string => (v ?? '').slice(0, 10);

export async function reconciliarTurmas(): Promise<RelatorioDeTurmas> {
  const periodoLetivo = cfg.rm.escopo.periodoLetivo;
  if (!periodoLetivo) {
    throw new LeituraDeTurmasQuebrada(
      'defina RM_CODPERLET no ambiente do worker',
      'RM_CODPERLET vazio: é parte da chave do de-para COURSE',
    );
  }

  const doRm = await wsDataServerClient.readView(
    'EduTurmaDiscData',
    `STurmaDisc.CODCOLIGADA=${cfg.rm.escopo.coligada} AND STurmaDisc.CODFILIAL=${cfg.rm.escopo.filiais}`,
    'STURMADISC',
    cfg.rm.escopo.filiais,
  );

  /*
   * Zero turma-disciplina NÃO é "nada mudou".
   *
   * Uma escola em atividade sempre tem turma-disciplina. Zero aqui significa
   * credencial recusada, filtro errado ou DataServer indisponível — e o
   * relatório sairia dizendo "sem deriva", que é a conclusão oposta à verdade.
   */
  if (doRm.length === 0) {
    throw new LeituraDeTurmasQuebrada(
      'confira a credencial do RM (code FE005 = senha expirada), o RM_CODFILIAL e se o ' +
        'EduTurmaDiscData responde',
      'o RM não devolveu NENHUMA turma-disciplina no campus — escola em atividade sempre tem',
    );
  }

  const ativos = await idMappingRepository.listByType('COURSE', 'active');
  const arquivados = await idMappingRepository.listByType('COURSE', 'archived');
  const mapeadas = new Map(ativos.map((c) => [c.rmCode, c]));

  const chaveDe = (r: { CODTURMA?: string; CODDISC?: string }): string =>
    chaveCourse(periodoLetivo, String(r.CODTURMA ?? ''), String(r.CODDISC ?? ''));
  const alvoDe = (r: { IDTURMADISC?: string; CODTURMA?: string; CODDISC?: string }) => ({
    idTurmaDisc: String(r.IDTURMADISC ?? ''),
    codTurma: String(r.CODTURMA ?? ''),
    codDisc: String(r.CODDISC ?? ''),
  });

  // As duas convenções de chave convivem enquanto o de-para migra de
  // IDTURMADISC para a chave natural. Ver domain/resolvedorCourse.ts.
  const estaMapeada = criarResolvedorDeCourse(ativos, periodoLetivo);
  const estaArquivada = criarResolvedorDeCourse(arquivados, periodoLetivo);

  // O IDPERLET corrente vem do que as turmas MAPEADAS usam — nunca cravado no
  // código, porque é por filial e muda todo ano.
  const perletsMapeados = new Map<string, number>();
  for (const r of doRm) {
    if (estaMapeada(alvoDe(r)).toddleId) {
      perletsMapeados.set(r.IDPERLET, (perletsMapeados.get(r.IDPERLET) ?? 0) + 1);
    }
  }
  const perlet = [...perletsMapeados.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!perlet) {
    throw new LeituraDeTurmasQuebrada(
      'confira o RM_CODFILIAL e o de-para COURSE — depois de cópia de base, os IDTURMADISC ' +
        'renumeram e o de-para pode ter ficado apontando para turmas que não existem mais',
      `o RM devolveu ${doRm.length} turma-disciplina e NENHUMA bate com o de-para: sem isso não ` +
        'dá para inferir o período letivo corrente, e todo o resto seria chute',
    );
  }

  const doPerlet = doRm.filter((r) => r.IDPERLET === perlet);

  /*
   * Quem tem aluno distingue turma de verdade de oferta vazia.
   *
   * As 16 turmas "IG" estão ativas e sem um único aluno; sem este sinal elas
   * apareceriam como lacuna e poluiriam o relatório todo mês. Falhar aqui não
   * derruba a reconciliação — o relatório sai mais pobre e DIZ que saiu, em vez
   * de calar e classificar turma com aluno como oferta vazia.
   */
  const alunosPorTd = new Map<string, Set<string>>();
  let semSinalDeAlunos = false;
  try {
    const alunos = (await idMappingRepository.listByType('STUDENT', 'active')).map((a) => a.rmCode);
    const r = await fetchNotasFromRm(doPerlet.map((x) => x.IDTURMADISC), alunos);
    for (const n of r.notas) {
      if (!alunosPorTd.has(n.idTurmaDisc)) alunosPorTd.set(n.idTurmaDisc, new Set());
      alunosPorTd.get(n.idTurmaDisc)?.add(n.ra);
    }
  } catch (e) {
    semSinalDeAlunos = true;
    logger.warn(
      { err: e instanceof Error ? e.message : e },
      'Não consegui medir alunos por turma — turma nova sairá como NOVA_SEM_ALUNOS sem isso ser verdade',
    );
  }

  const achados: Achado[] = [];
  const vistas = new Set<string>();

  for (const r of doPerlet) {
    const chave = chaveDe(r);
    vistas.add(chave);
    const ativaNoRm = (r.ATIVA ?? '').toUpperCase() === 'S';
    const alunos = alunosPorTd.get(r.IDTURMADISC)?.size ?? 0;
    const base: Achado = {
      situacao: 'OK',
      idTurmaDisc: r.IDTURMADISC,
      codTurma: r.CODTURMA,
      codDisc: r.CODDISC,
      nomeDisc: r.NOMEDISC,
      ativa: r.ATIVA,
      alunos,
      criadoEm: soData(r.RECCREATEDON),
      alteradoEm: soData(r.RECMODIFIEDON),
    };

    if (estaMapeada(alvoDe(r)).toddleId) {
      achados.push({ ...base, situacao: ativaNoRm ? 'OK' : 'INATIVADA_NO_RM' });
    } else if (estaArquivada(alvoDe(r)).toddleId) {
      if (ativaNoRm) achados.push({ ...base, situacao: 'REATIVADA_NO_RM' });
    } else if (ativaNoRm) {
      // Sem o sinal de alunos, NÃO dá para afirmar "sem aluno" — e afirmar isso
      // esconderia exatamente a turma que este fluxo existe para achar.
      achados.push({
        ...base,
        situacao: !semSinalDeAlunos && alunos === 0 ? 'NOVA_SEM_ALUNOS' : 'NOVA_COM_ALUNOS',
      });
    }
  }

  // Mapeada e ausente do RM: não há linha de onde tirar o IDTURMADISC, então a
  // chave do de-para é o que se mostra — e é mais legível de qualquer forma.
  for (const [chave] of mapeadas) {
    if (!vistas.has(chave)) achados.push({ situacao: 'SUMIU_DO_RM', idTurmaDisc: chave });
  }

  // Deriva de rótulo: o título no Toddle ainda contém o nome da disciplina?
  const nossos = new Set(ativos.map((c) => c.toddleId));
  const classes = (await toddleClient.listClasses()).filter((c) => nossos.has(String(c.id)));
  const tituloPorChave = new Map<string, string>();
  for (const c of ativos) {
    const t = classes.find((x) => String(x.id) === c.toddleId);
    if (t) tituloPorChave.set(c.rmCode, String(t.title ?? ''));
  }
  const renomeadas = doPerlet
    .filter((r) => {
      const titulo = tituloPorChave.get(chaveDe(r));
      const disc = (r.NOMEDISC ?? '').trim();
      if (!titulo || !disc) return false;
      return !titulo.toLowerCase().includes(disc.toLowerCase());
    })
    .map((r) => ({
      idTurmaDisc: r.IDTURMADISC,
      noRm: (r.NOMEDISC ?? '').trim(),
      noToddle: tituloPorChave.get(chaveDe(r)) ?? '',
    }));

  const porSituacao: Record<string, number> = {};
  for (const a of achados) porSituacao[a.situacao] = (porSituacao[a.situacao] ?? 0) + 1;

  return {
    idPerlet: perlet,
    lidasDoRm: doRm.length,
    doPeriodoCorrente: doPerlet.length,
    mapeadasAtivas: ativos.length,
    mapeadasArquivadas: arquivados.length,
    achados,
    porSituacao,
    renomeadas,
    semSinalDeAlunos,
  };
}

/** Os achados que ninguém resolve sem decidir. É o número que a tela mostra. */
export function exigemDecisao(r: RelatorioDeTurmas): Achado[] {
  return r.achados.filter((a) => EXIGEM_DECISAO.includes(a.situacao));
}
