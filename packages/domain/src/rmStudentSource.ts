import { rmSoapConfigurado, tenantConfig } from '@rm-toddle/config';
import { wsConsultaSqlClient, ConsultaRow } from '@rm-toddle/integrations';
import { RmStudentContext } from '@rm-toddle/integrations';
import { StudentEnrichment } from '@rm-toddle/contracts';
import { sanitizeEmail } from '@rm-toddle/config';
import { logger } from '@rm-toddle/config';

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
 * Fonte de alunos do RM via wsConsultaSQL (SOAP), no lugar do REST /StudentContexts.
 *
 * Uma ÚNICA Sentença (RM_SENTENCA_STUDENTS) devolve o roster completo já com os
 * campos de enriquecimento (email/nascimento/gênero) no mesmo rowset — não há
 * segundo round-trip. A própria Sentença filtra os alunos ATIVOS no SQL
 * (CODSTATUS/matrícula), então RM_ACTIVE_TERM_STATUSES pode ficar vazio.
 *
 * Parâmetros passados à Sentença: CODCOLIGADA e CODPERLET (período letivo).
 *
 * Colunas esperadas (case-insensitive; ausentes viram undefined):
 *   RA             (obrigatória)  código de negócio -> StudentCode / sourceId
 *   NOME_COMPLETO  (obrigatória)  nome completo -> StudentName (split no middleware)
 *   COD_TURMA      (recomendada)  turma -> ClassCode (resolve o yearGroup via de-para)
 *   CODCURSO       (alt.)         série/curso -> CourseCode (fallback do yearGroup)
 *   CODINTERNO     (opcional)     chave interna do RM -> StudentInternalId
 *   EMAIL          (opcional)     e-mail institucional (precedência)
 *   EMAIL_PESSOAL  (opcional)     e-mail pessoal (fallback)
 *   DTNASCIMENTO   (opcional)     nascimento (ISO ou dd/mm/aaaa)
 *   SEXO           (opcional)     gênero (M/F)
 */
/**
 * Quantos alunos o RM diz ter alterado — a pergunta que o contador de upsert não
 * responde.
 *
 * `updated: 50` nunca significou "50 alunos mudaram": 50 é o tamanho do lote, e o
 * job reenviava todo mundo a cada passada. Medido em 23/09/2026 pelo
 * `RECMODIFIEDON` do próprio RM: dos 866 alunos da coligada, ZERO tinham mudado
 * nas últimas 24h e 5 na última semana — enquanto o sync mandava 252 PATCH por
 * rodada, 4x ao dia.
 *
 * Os três carimbos são de tabelas diferentes e todos importam: a ficha do aluno
 * (`SALUNO`), a ficha pessoal (`PPESSOA`, onde moram nome e e-mail) e a matrícula
 * (`SMATRICPL`, onde mora a turma). Quem manda é o mais recente dos três.
 *
 * `null` = a Sentença em vigor no RM ainda não tem as colunas. É informação
 * ausente, e dizer "0 alterados" nesse caso seria inventar uma medição.
 */
export interface AlteracoesNoRm {
  ultimas24h: number;
  ultimos7dias: number;
  /** ISO do carimbo mais recente entre os alunos em escopo. */
  maisRecenteEm: string | null;
  /** Alunos em escopo que trouxeram carimbo — o denominador da conta. */
  comCarimbo: number;
}

export async function fetchStudentsFromRm(): Promise<{
  contexts: RmStudentContext[];
  enrichmentByCode: Map<string, StudentEnrichment>;
  alteracoesNoRm: AlteracoesNoRm | null;
}> {
  if (!rmSoapConfigurado) {
    throw new Error('wsConsultaSQL não configurado (RM_WS_BASEURL/RM_WS_USER/RM_WS_PASS).');
  }
  if (!cfg.rm.sentencas.alunos) {
    throw new Error(
      'RM_SENTENCA_STUDENTS não definido — informe o código da Sentença SQL de alunos cadastrada no RM.',
    );
  }
  if (!cfg.rm.escopo.periodoLetivo) {
    throw new Error(
      'RM_CODPERLET não definido — a Sentença de alunos exige o período letivo (ex.: 2026).',
    );
  }

  const rows = await wsConsultaSqlClient.realizarConsulta(cfg.rm.sentencas.alunos, {
    CODCOLIGADA: cfg.rm.escopo.coligada,
    CODPERLET: cfg.rm.escopo.periodoLetivo,
  });

  const contexts: RmStudentContext[] = [];
  const enrichmentByCode = new Map<string, StudentEnrichment>();
  const carimboPorAluno = new Map<string, string>();

  // Escopo por campus: a integração cobre apenas o(s) CODFILIAL listado(s) em
  // RM_CODFILIAL. O literal "ALL" inclui todos os campi — mas é uma DECLARAÇÃO
  // explícita, não o default de antes. Variável ausente não chega aqui: o Zod
  // aborta o processo (ver config/env.ts).
  const allBranches = cfg.rm.escopo.filiais.trim().toUpperCase() === 'ALL';
  const allowedBranches = allBranches
    ? []
    : cfg.rm.escopo.filiais.split(',').map((s) => s.trim()).filter(Boolean);

  if (!allBranches && allowedBranches.length === 0) {
    throw new Error(
      `RM_CODFILIAL="${cfg.rm.escopo.filiais}" não produziu nenhum campus válido. ` +
        'Informe os códigos separados por vírgula (ex.: "2") ou "ALL".',
    );
  }
  let outOfScope = 0;

  for (const row of rows) {
    const studentCode = pick(row, 'RA', 'STUDENTCODE', 'CODIGO');
    if (!studentCode) continue; // linha sem RA não sincroniza

    const branchCode = pick(row, 'CODFILIAL', 'BRANCHCODE');
    if (!allBranches && (!branchCode || !allowedBranches.includes(branchCode))) {
      outOfScope += 1;
      continue;
    }

    contexts.push({
      StudentCode: studentCode,
      StudentInternalId: pick(row, 'CODINTERNO', 'STUDENTINTERNALID', 'IDALUNO'),
      StudentName: pick(row, 'NOME_COMPLETO', 'NOME', 'STUDENTNAME', 'NOMEALUNO'),
      CourseCode: pick(row, 'CODCURSO', 'COD_CURSO', 'COURSECODE'),
      ClassCode: pick(row, 'COD_TURMA', 'CODTURMA', 'CLASSCODE'),
      ClassName: pick(row, 'NOME_TURMA', 'NOMETURMA', 'CLASSNAME'),
      BranchCode: branchCode,
      TermCode: pick(row, 'CODPERLET', 'TERMCODE', 'IDPERLET'),
      MajorStatus: pick(row, 'STATUSCURSO', 'MAJORSTATUS'),
      TermStatus: pick(row, 'STATUS_MATRICULA', 'STATUSPERIODO', 'TERMSTATUS'),
      IsActiveTerm: pick(row, 'STATUS_ATIVO', 'STATUSATIVO', 'PLATIVO'),
      TermStatusName: pick(row, 'STATUS_DESCRICAO', 'STATUSDESCRICAO'),
    });

    // O mais recente dos três carimbos do RM. Um aluno pode aparecer em mais de
    // uma linha (uma por contexto de matrícula): fica o maior.
    const carimbo = maisRecente(
      pick(row, 'PESSOA_ALTERADA_EM'),
      pick(row, 'MATRICULA_ALTERADA_EM'),
      pick(row, 'ALUNO_ALTERADO_EM'),
    );
    if (carimbo) {
      const anterior = carimboPorAluno.get(studentCode);
      if (!anterior || carimbo > anterior) carimboPorAluno.set(studentCode, carimbo);
    }

    // E-mail: institucional (EMAIL) tem precedência; pessoal (EMAILPESSOAL) é
    // fallback. Para inverter, troque a ordem das duas linhas abaixo.
    const email =
      sanitizeEmail(pick(row, 'EMAIL')) ??
      sanitizeEmail(pick(row, 'EMAIL_PESSOAL', 'EMAILPESSOAL', 'EMAILPARTICULAR'));

    const gender = pick(row, 'SEXO', 'GENDER')?.toUpperCase();
    const enrichment: StudentEnrichment = {
      email,
      dob: toIsoDate(pick(row, 'DT_NASCIMENTO', 'DTNASCIMENTO', 'DOB', 'DATANASCIMENTO')),
      gender: gender === 'M' || gender === 'F' ? gender : undefined,
    };
    if (enrichment.email || enrichment.dob || enrichment.gender) {
      enrichmentByCode.set(studentCode, enrichment);
    }
  }

  const alteracoesNoRm = resumirAlteracoes(carimboPorAluno);

  logger.info(
    {
      linhas: rows.length,
      alunos: contexts.length,
      enriquecidos: enrichmentByCode.size,
      foraDoEscopo: outOfScope,
      campi: allowedBranches.length > 0 ? allowedBranches.join(',') : 'todos',
      alteradosNoRm24h: alteracoesNoRm?.ultimas24h ?? 'sem carimbo na Sentença',
    },
    'Roster de alunos lido via wsConsultaSQL',
  );

  return { contexts, enrichmentByCode, alteracoesNoRm };
}

/** O maior de três carimbos ISO, ignorando vazio. Comparação lexicográfica basta em ISO. */
function maisRecente(...valores: Array<string | undefined>): string | undefined {
  let maior: string | undefined;
  for (const v of valores) {
    const limpo = v?.trim();
    if (!limpo) continue;
    if (!maior || limpo > maior) maior = limpo;
  }
  return maior;
}

/** Conta quantos carimbos caem nas janelas. `null` quando a Sentença não os traz. */
function resumirAlteracoes(carimbos: Map<string, string>): AlteracoesNoRm | null {
  if (carimbos.size === 0) return null;
  const agora = Date.now();
  const dentro = (iso: string, dias: number): boolean => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && agora - t <= dias * 86_400_000;
  };
  let ultimas24h = 0;
  let ultimos7dias = 0;
  let maisRecenteEm: string | null = null;
  for (const iso of carimbos.values()) {
    if (dentro(iso, 1)) ultimas24h += 1;
    if (dentro(iso, 7)) ultimos7dias += 1;
    if (!maisRecenteEm || iso > maisRecenteEm) maisRecenteEm = iso;
  }
  return { ultimas24h, ultimos7dias, maisRecenteEm, comCarimbo: carimbos.size };
}

/** Busca uma coluna por vários nomes possíveis (case-insensitive), trimada. */
function pick(row: ConsultaRow, ...names: string[]): string | undefined {
  for (const name of names) {
    // Match direto e depois case-insensitive.
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

/** Normaliza data do RM (ISO "2010-05-01T00:00:00", "2010-05-01" ou "01/05/2010") em YYYY-MM-DD. */
function toIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;

  // dd/mm/aaaa
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;

  // ISO (com ou sem hora) — pega os 10 primeiros chars se já for válido
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  return undefined; // formato desconhecido: omite (campo é opcional no Toddle)
}
