import { pgPool } from '../db/pool';
import { env } from '../config/env';

export const ENTITY_TYPES = [
  'STUDENT',
  'STAFF',
  'PARENT',
  'COURSE',
  // Toddle 2.0: a EAV usa o modelo TeacherCourse (uma "turma do professor" por
  // disciplina/docente), distinto do course clássico do 1.0. O Fluxo 2 mapeia
  // STURMADISC do RM para TEACHER_COURSE.
  'TEACHER_COURSE',
  'SUBJECT',
  'YEAR_GROUP',
  /** Registro que existe no Toddle e NAO tem contrapartida no RM (demo do sandbox). */
  'TODDLE_DEMO',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** Ciclo de vida da linha. 'archived' NUNCA vira DELETE — ver nota no repositório. */
export type MappingState = 'active' | 'archived';

export interface IdMapping {
  id: string;
  entityType: EntityType;
  rmCode: string;
  rmInternalId: string | null;
  toddleId: string;
  /** Organização Toddle a que este mapeamento pertence (env.TODDLE_ORG_ID). */
  targetInstanceKey: string;
  state: MappingState;
  archivedAt: Date | null;
  archiveReason: string | null;
  lastSeenInScopeAt: Date | null;
  /** Só YEAR_GROUP: currículo Toddle onde aquele yearGroupId vive. */
  curriculumId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface IdMappingRow {
  id: string;
  entity_type: EntityType;
  rm_code: string;
  rm_internal_id: string | null;
  toddle_id: string;
  target_instance_key: string;
  state: MappingState;
  archived_at: Date | null;
  archive_reason: string | null;
  last_seen_in_scope_at: Date | null;
  curriculum_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const mapRow = (r: IdMappingRow): IdMapping => ({
  id: r.id,
  entityType: r.entity_type,
  rmCode: r.rm_code,
  rmInternalId: r.rm_internal_id,
  toddleId: r.toddle_id,
  targetInstanceKey: r.target_instance_key,
  state: r.state,
  archivedAt: r.archived_at,
  archiveReason: r.archive_reason,
  lastSeenInScopeAt: r.last_seen_in_scope_at,
  curriculumId: r.curriculum_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * Repositório da tabela de mapeamento RM <-> Toddle.
 *
 * Convenções que não podem ser quebradas:
 *
 * 1. `rm_code` guarda o CÓDIGO DE NEGÓCIO do RM (RA, CHAPA, CODTURMA...) — nunca
 *    o InternalId, que é chave técnica e fica só como referência.
 *
 * 2. TODA consulta é escopada por `target_instance_key` = env.TODDLE_ORG_ID. Uma
 *    linha significa "esta entidade do RM NESTA organização Toddle". Consultar
 *    sem esse filtro devolveria mapeamentos de outra organização, cujos ids não
 *    existem no destino atual.
 *
 * 3. ARQUIVAR NUNCA APAGA. Não existe DELETE aqui de propósito: o GET /students
 *    do Toddle não devolve aluno arquivado (nem filtrando por sourceId) e a API
 *    não tem DELETE de aluno, então o `toddle_id` guardado nesta tabela é o
 *    ÚNICO caminho de volta. Em 31/07/2026 arquivamos 186 alunos E apagamos as
 *    linhas; aqueles registros ficaram inalcançáveis por API. Use markArchived.
 */
export const idMappingRepository = {
  async findByRmCode(entityType: EntityType, rmCode: string): Promise<IdMapping | null> {
    const { rows } = await pgPool.query<IdMappingRow>(
      `SELECT * FROM id_mapping
        WHERE entity_type = $1 AND rm_code = $2 AND target_instance_key = $3`,
      [entityType, rmCode, env.TODDLE_ORG_ID],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  },

  /**
   * Busca em lote — caminho rápido do worker antes de consultar o Toddle.
   * Devolve linhas de QUALQUER estado: um mapeamento 'archived' é justamente o
   * que permite desarquivar um aluno que voltou ao escopo, coisa que a busca por
   * sourceId no Toddle não consegue fazer (arquivado é invisível lá).
   */
  async findManyByRmCodes(entityType: EntityType, rmCodes: string[]): Promise<Map<string, IdMapping>> {
    const result = new Map<string, IdMapping>();
    if (rmCodes.length === 0) return result;
    const { rows } = await pgPool.query<IdMappingRow>(
      `SELECT * FROM id_mapping
        WHERE entity_type = $1 AND rm_code = ANY($2) AND target_instance_key = $3`,
      [entityType, rmCodes, env.TODDLE_ORG_ID],
    );
    for (const row of rows) result.set(row.rm_code, mapRow(row));
    return result;
  },

  async findByToddleId(entityType: EntityType, toddleId: string): Promise<IdMapping | null> {
    const { rows } = await pgPool.query<IdMappingRow>(
      `SELECT * FROM id_mapping
        WHERE entity_type = $1 AND toddle_id = $2 AND target_instance_key = $3`,
      [entityType, toddleId, env.TODDLE_ORG_ID],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  },

  /**
   * Upsert idempotente pela chave de negócio (entity_type + rm_code + destino).
   * É o coração da garantia de "não duplicar registros".
   *
   * Um upsert bem-sucedido significa "vi este aluno no escopo agora": marca
   * `last_seen_in_scope_at`, devolve o estado para 'active' e limpa os campos de
   * arquivamento — é o caminho natural de quem volta ao escopo.
   */
  async upsert(input: {
    entityType: EntityType;
    rmCode: string;
    toddleId: string;
    rmInternalId?: string | null;
    curriculumId?: string | null;
  }): Promise<IdMapping> {
    const { rows } = await pgPool.query<IdMappingRow>(
      `INSERT INTO id_mapping
             (entity_type, rm_code, rm_internal_id, toddle_id, target_instance_key,
              curriculum_id, state, last_seen_in_scope_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', now())
       ON CONFLICT (entity_type, rm_code, target_instance_key) DO UPDATE
         SET toddle_id             = EXCLUDED.toddle_id,
             rm_internal_id        = COALESCE(EXCLUDED.rm_internal_id, id_mapping.rm_internal_id),
             curriculum_id         = COALESCE(EXCLUDED.curriculum_id, id_mapping.curriculum_id),
             state                 = 'active',
             archived_at           = NULL,
             archive_reason        = NULL,
             last_seen_in_scope_at = now(),
             updated_at            = now()
       RETURNING *`,
      [
        input.entityType,
        input.rmCode,
        input.rmInternalId ?? null,
        input.toddleId,
        env.TODDLE_ORG_ID,
        input.curriculumId ?? null,
      ],
    );
    return mapRow(rows[0]);
  },

  /**
   * Marca como arquivado PRESERVANDO a linha e o toddle_id. Contrapartida local
   * do PUT /:id/archive no Toddle — chamar sempre em par com ele.
   */
  async markArchived(
    entityType: EntityType,
    rmCode: string,
    reason: string,
  ): Promise<IdMapping | null> {
    const { rows } = await pgPool.query<IdMappingRow>(
      `UPDATE id_mapping
          SET state          = 'archived',
              archived_at    = now(),
              archive_reason = $4,
              updated_at     = now()
        WHERE entity_type = $1 AND rm_code = $2 AND target_instance_key = $3
        RETURNING *`,
      [entityType, rmCode, env.TODDLE_ORG_ID, reason],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  },

  /**
   * Candidatos a arquivamento: linhas ATIVAS nesta organização cujo rm_code NÃO
   * está na lista de códigos vistos no escopo. Recebe a lista do que está em
   * escopo (não do que saiu) de propósito — assim um snapshot vazio por falha de
   * leitura não é interpretado como "todos saíram".
   */
  async findActiveNotIn(entityType: EntityType, rmCodesInScope: string[]): Promise<IdMapping[]> {
    const { rows } = await pgPool.query<IdMappingRow>(
      `SELECT * FROM id_mapping
        WHERE entity_type = $1
          AND target_instance_key = $2
          AND state = 'active'
          AND NOT (rm_code = ANY($3))
        ORDER BY rm_code`,
      [entityType, env.TODDLE_ORG_ID, rmCodesInScope],
    );
    return rows.map(mapRow);
  },

  /** Escopado no destino atual. Passe `state` para filtrar ativos/arquivados. */
  async listByType(entityType: EntityType, state?: MappingState): Promise<IdMapping[]> {
    const { rows } = await pgPool.query<IdMappingRow>(
      `SELECT * FROM id_mapping
        WHERE entity_type = $1
          AND target_instance_key = $2
          AND ($3::text IS NULL OR state = $3)
        ORDER BY rm_code`,
      [entityType, env.TODDLE_ORG_ID, state ?? null],
    );
    return rows.map(mapRow);
  },
};
