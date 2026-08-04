import { env, isRmSoapConfigured } from '../config/env';
import { wsConsultaSqlClient, ConsultaRow } from '../clients/rm-soap/wsConsultaSqlClient';
import { RmStudentContext } from '../clients/totvs/types';
import { StudentEnrichment } from '../schemas/jobs.schema';
import { sanitizeEmail } from '../utils/name';
import { logger } from '../utils/logger';

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
export async function fetchStudentsFromRm(): Promise<{
  contexts: RmStudentContext[];
  enrichmentByCode: Map<string, StudentEnrichment>;
}> {
  if (!isRmSoapConfigured) {
    throw new Error('wsConsultaSQL não configurado (RM_WS_BASEURL/RM_WS_USER/RM_WS_PASS).');
  }
  if (!env.RM_SENTENCA_STUDENTS) {
    throw new Error(
      'RM_SENTENCA_STUDENTS não definido — informe o código da Sentença SQL de alunos cadastrada no RM.',
    );
  }
  if (!env.RM_CODPERLET) {
    throw new Error(
      'RM_CODPERLET não definido — a Sentença de alunos exige o período letivo (ex.: 2026).',
    );
  }

  const rows = await wsConsultaSqlClient.realizarConsulta(env.RM_SENTENCA_STUDENTS, {
    CODCOLIGADA: env.RM_CODCOLIGADA,
    CODPERLET: env.RM_CODPERLET,
  });

  const contexts: RmStudentContext[] = [];
  const enrichmentByCode = new Map<string, StudentEnrichment>();

  // Escopo por campus: a integração cobre apenas o(s) CODFILIAL listado(s) em
  // RM_CODFILIAL. O literal "ALL" inclui todos os campi — mas é uma DECLARAÇÃO
  // explícita, não o default de antes. Variável ausente não chega aqui: o Zod
  // aborta o processo (ver config/env.ts).
  const allBranches = env.RM_CODFILIAL.trim().toUpperCase() === 'ALL';
  const allowedBranches = allBranches
    ? []
    : env.RM_CODFILIAL.split(',').map((s) => s.trim()).filter(Boolean);

  if (!allBranches && allowedBranches.length === 0) {
    throw new Error(
      `RM_CODFILIAL="${env.RM_CODFILIAL}" não produziu nenhum campus válido. ` +
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

  logger.info(
    {
      linhas: rows.length,
      alunos: contexts.length,
      enriquecidos: enrichmentByCode.size,
      foraDoEscopo: outOfScope,
      campi: allowedBranches.length > 0 ? allowedBranches.join(',') : 'todos',
    },
    'Roster de alunos lido via wsConsultaSQL',
  );

  return { contexts, enrichmentByCode };
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
