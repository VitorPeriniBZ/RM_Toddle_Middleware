import { logger, rmSoapConfigurado, sanitizeEmail, tenantConfig } from '@rm-toddle/config';
import { wsConsultaSqlClient, ConsultaRow } from '@rm-toddle/integrations';

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
 * Fonte de PROFESSOR e de alocação turma-disciplina-docente, via a Sentença
 * `TODDLE.TURMADISC` (wsConsultaSQL).
 *
 * ─── POR QUE ESTA SENTENÇA, E NÃO O DATASERVER ──────────────────────────────
 *
 * `reconciliar:turmas` lê `EduTurmaDiscData`, que devolve a turma-disciplina com
 * 39 colunas — mas NÃO o professor alocado. Esta Sentença existe exatamente para
 * cobrir essa lacuna. Medido em 10/08/2026 (coligada 1, perlet 2026):
 *
 *   648 linhas no total · 286 no campus 2 · 202 turma-disciplina distintas
 *    35 professores distintos · 0 linhas sem CODPROF
 *
 * ─── A GRANULARIDADE É A ALOCAÇÃO, NÃO O PROFESSOR ──────────────────────────
 *
 * Uma linha = um professor numa turma-disciplina. Logo há repetição em ambos os
 * eixos: **70 das 202 turma-disciplina têm mais de um professor** (até três), e
 * um professor aparece em várias. Quem consome precisa agrupar — e é por isso
 * que esta função devolve as duas visões prontas, em vez do rowset cru.
 */

/** Um professor, deduplicado por CODPROF. */
export interface RmTeacher {
  /** `CODPROF` — chave de negócio, vira o `rm_code` do mapeamento STAFF. */
  codProf: string;
  nome: string;
  /** Institucional tem precedência; pessoal é fallback. `undefined` = bloqueia criação. */
  email?: string;
  /** IDs de turma-disciplina em que ele leciona (no escopo). */
  turmaDiscIds: string[];
}

/** Uma turma-disciplina com os professores alocados. */
export interface RmTurmaDisc {
  /** `ID_TURMADISC` — casa com o `rm_code` do mapeamento COURSE. */
  idTurmaDisc: string;
  codTurma: string;
  nomeTurma: string;
  codDisc: string;
  nomeDisciplina: string;
  segmento: string;
  serie: string;
  secao: string;
  ativa: boolean;
  /** CODPROF dos docentes alocados. Pode ter mais de um. */
  codProfs: string[];
  /**
   * Turma que existe no RM só por conveniência de lançamento e NÃO deve virar
   * turma no Toddle (`RM_TURMAS_IGNORADAS`). Na EAV, a "turma Gerenciada" (`IG`).
   *
   * Marcada em vez de descartada: descartar faria a contagem mentir e esconderia
   * o caso em que um professor estivesse alocado SÓ na gerenciada — aí ele
   * ficaria invisível nas turmas reais, e ninguém saberia. Verificado em
   * 11/08/2026 que isso não ocorre (0 de 16), mas o dado continua disponível
   * para a checagem seguir existindo.
   */
  gerenciada: boolean;
}

export interface RmTeacherData {
  professores: Map<string, RmTeacher>;
  turmaDiscs: Map<string, RmTurmaDisc>;
  /** Linhas descartadas por campus fora de escopo (RM_CODFILIAL). */
  foraDoEscopo: number;
  /** Linhas sem CODPROF — turma-disciplina sem docente alocado no RM. */
  semProfessor: number;
}

export async function fetchTeachersFromRm(): Promise<RmTeacherData> {
  if (!rmSoapConfigurado) {
    throw new Error('wsConsultaSQL não configurado (RM_WS_BASEURL/RM_WS_USER/RM_WS_PASS).');
  }
  if (!cfg.rm.sentencas.turmaDisc) {
    throw new Error(
      'RM_SENTENCA_TURMADISC não definido — informe o código da Sentença de turma-disciplina-professor ' +
        '(ex.: TODDLE.TURMADISC). Ver docs/rm-sentencas/TODDLE.TURMADISC.ESPEC.md.',
    );
  }
  if (!cfg.rm.escopo.periodoLetivo) {
    throw new Error('RM_CODPERLET não definido — a Sentença exige o período letivo (ex.: 2026).');
  }

  const rows = await wsConsultaSqlClient.realizarConsulta(cfg.rm.sentencas.turmaDisc, {
    CODCOLIGADA: cfg.rm.escopo.coligada,
    CODPERLET: cfg.rm.escopo.periodoLetivo,
  });

  // ─── A SENTENÇA REGISTRADA É A QUE ESPERAMOS? ────────────────────────────
  //
  // Medido em 25/08/2026: a `TODDLE.TURMADISC` registrada no RM era uma versão
  // ANTIGA, sem NENHUMA coluna de e-mail. O efeito não foi um erro — foi pior:
  // todo professor apareceu como "sem e-mail", a secretaria cadastrou dois
  // e-mails de verdade, e nada mudou, porque a pergunta nunca era feita. Levou
  // uma investigação inteira para descobrir que o defeito estava na consulta e
  // não no dado. (Já tinha acontecido com a TODDLE.RESP, pelo mesmo motivo.)
  //
  // Divergência entre o `.sql` do repositório e a Sentença registrada é invisível
  // por natureza: o SELECT roda, devolve linhas, e as colunas que faltam viram
  // `undefined` — indistinguível de "o RM não tem esse dado".
  //
  // Aviso, e não exceção: sem as colunas de e-mail o sync ainda faz o resto do
  // trabalho (turmas, vínculos de quem já está mapeado), e derrubá-lo tiraria
  // mais do que devolve. Mas o aviso nomeia exatamente o que falta e o que fazer.
  const colunasVistas = new Set(Object.keys(rows[0] ?? {}).map((k) => k.toUpperCase()));
  const esperadas = [
    'EMAIL_PROFESSOR',
    'EMAIL_PROF_PESSOAL',
    'EMAIL_PROF_USUARIO',
    'AULAS_SEMANAIS',
  ];
  const ausentes = esperadas.filter((c) => !colunasVistas.has(c));
  if (rows.length > 0 && ausentes.length > 0) {
    logger.warn(
      {
        sentenca: cfg.rm.sentencas.turmaDisc,
        colunasAusentes: ausentes,
        colunasRecebidas: [...colunasVistas].sort(),
      },
      'A Sentença registrada no RM está DESATUALIZADA em relação a ' +
        'docs/rm-sentencas/TODDLE.TURMADISC.sql — as colunas acima não vêm na ' +
        'resposta. Enquanto isso, todo professor será tratado como "sem e-mail" ' +
        'e nenhum será criado no Toddle, mesmo que o cadastro do RM esteja certo. ' +
        'Recadastre a Sentença com o conteúdo do arquivo.',
    );
  }

  // Escopo por campus, idêntico ao da Sentença de alunos. A Sentença NÃO filtra
  // campus de propósito (ver ESPEC §2), então o filtro vive aqui — e é o que
  // mantém a D4 (Pre-K a Grade 5 fora) valendo: das 648 linhas, 286 são campus 2.
  const todosOsCampi = cfg.rm.escopo.filiais.trim().toUpperCase() === 'ALL';
  const permitidos = todosOsCampi
    ? []
    : cfg.rm.escopo.filiais.split(',').map((s) => s.trim()).filter(Boolean);
  if (!todosOsCampi && permitidos.length === 0) {
    throw new Error(`RM_CODFILIAL="${cfg.rm.escopo.filiais}" não produziu campus válido.`);
  }

  // Regex de turma ignorada. Inválida NÃO degrada para "nada ignorado": isso
  // faria 16 falsos positivos voltarem em silêncio no relatório.
  let ignorar: RegExp | undefined;
  if (cfg.rm.escopo.turmasIgnoradas?.trim()) {
    try {
      ignorar = new RegExp(cfg.rm.escopo.turmasIgnoradas.trim());
    } catch (e) {
      throw new Error(
        `RM_TURMAS_IGNORADAS="${cfg.rm.escopo.turmasIgnoradas}" não é regex válida: ${(e as Error).message}`,
      );
    }
  }

  const professores = new Map<string, RmTeacher>();
  const turmaDiscs = new Map<string, RmTurmaDisc>();
  let foraDoEscopo = 0;
  let semProfessor = 0;

  for (const row of rows) {
    const idTurmaDisc = pick(row, 'ID_TURMADISC');
    if (!idTurmaDisc) continue; // linha sem chave não é acionável

    const campus = pick(row, 'CODFILIAL');
    if (!todosOsCampi && (!campus || !permitidos.includes(campus))) {
      foraDoEscopo += 1;
      continue;
    }

    if (!turmaDiscs.has(idTurmaDisc)) {
      turmaDiscs.set(idTurmaDisc, {
        idTurmaDisc,
        codTurma: pick(row, 'COD_TURMA') ?? '',
        nomeTurma: pick(row, 'NOME_TURMA') ?? '',
        codDisc: pick(row, 'CODDISC') ?? '',
        nomeDisciplina: pick(row, 'NOME_DISCIPLINA') ?? '',
        segmento: pick(row, 'SEGMENTO') ?? '',
        serie: pick(row, 'SERIE') ?? '',
        secao: pick(row, 'SECAO') ?? '',
        // 'S' = ativa. Qualquer outro valor conta como inativa, inclusive vazio:
        // na dúvida, NÃO tratar como ativa.
        ativa: (pick(row, 'TURMADISC_ATIVA') ?? '').toUpperCase() === 'S',
        codProfs: [],
        gerenciada: ignorar ? ignorar.test(pick(row, 'COD_TURMA') ?? '') : false,
      });
    }

    const codProf = pick(row, 'CODPROF');
    if (!codProf) {
      semProfessor += 1;
      continue;
    }

    const td = turmaDiscs.get(idTurmaDisc)!;
    if (!td.codProfs.includes(codProf)) td.codProfs.push(codProf);

    if (!professores.has(codProf)) {
      professores.set(codProf, {
        codProf,
        nome: pick(row, 'NOME_PROFESSOR') ?? '',
        // Institucional tem precedência. Sem nenhum dos dois, o professor NÃO
        // pode ser criado: o Toddle exige e-mail e o usa como IDENTIDADE —
        // e-mail errado gera conta inacessível, que só pode ser arquivada.
        // Três lugares, nesta ordem, porque o RM espalha e-mail de professor por
        // tabelas diferentes conforme a tela em que a escola cadastra:
        //   PPESSOA.EMAIL         ficha da pessoa, campo "E-Mail"
        //   PPESSOA.EMAILPESSOAL  ficha da pessoa, campo "E-Mail pessoal"
        //   GUSUARIO.EMAIL        conta de usuário do RM (PPESSOA.CODUSUARIO)
        //
        // O terceiro foi acrescentado em 25/08/2026: a secretaria cadastrou dois
        // professores e a Sentença continuou devolvendo nulo, porque o valor foi
        // parar na conta de usuário e não na ficha. Sem esse caminho, o sync
        // reportaria "sem e-mail" para alguém que TEM e-mail no RM — e a pessoa
        // ficaria sem turma no Toddle sem que ninguém entendesse por quê.
        email:
          sanitizeEmail(pick(row, 'EMAIL_PROFESSOR')) ??
          sanitizeEmail(pick(row, 'EMAIL_PROF_PESSOAL')) ??
          sanitizeEmail(pick(row, 'EMAIL_PROF_USUARIO')),
        turmaDiscIds: [],
      });
    }
    const prof = professores.get(codProf)!;
    if (!prof.turmaDiscIds.includes(idTurmaDisc)) prof.turmaDiscIds.push(idTurmaDisc);
  }

  logger.info(
    {
      linhas: rows.length,
      turmaDiscs: turmaDiscs.size,
      gerenciadas: [...turmaDiscs.values()].filter((t) => t.gerenciada).length,
      professores: professores.size,
      semEmail: [...professores.values()].filter((p) => !p.email).length,
      foraDoEscopo,
      semProfessor,
      campi: permitidos.length > 0 ? permitidos.join(',') : 'todos',
    },
    'Turma-disciplina-professor lida via wsConsultaSQL',
  );

  return { professores, turmaDiscs, foraDoEscopo, semProfessor };
}

/** Busca coluna por vários nomes (case-insensitive), trimada. */
function pick(row: ConsultaRow, ...names: string[]): string | undefined {
  for (const name of names) {
    const v = row[name];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  const lowered = new Map(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
  for (const name of names) {
    const v = lowered.get(name.toLowerCase());
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
}
