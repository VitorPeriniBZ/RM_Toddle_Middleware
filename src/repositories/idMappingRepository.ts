import { pgPool } from '../db/pool';

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
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export interface IdMapping {
  id: string;
  entityType: EntityType;
  rmCode: string;
  rmInternalId: string | null;
  toddleId: string;
  createdAt: Date;
  updatedAt: Date;
}

interface IdMappingRow {
  id: string;
  entity_type: EntityType;
  rm_code: string;
  rm_internal_id: string | null;
  toddle_id: string;
  created_at: Date;
  updated_at: Date;
}

const mapRow = (r: IdMappingRow): IdMapping => ({
  id: r.id,
  entityType: r.entity_type,
  rmCode: r.rm_code,
  rmInternalId: r.rm_internal_id,
  toddleId: r.toddle_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * Repositório da tabela de mapeamento RM <-> Toddle.
 * Convenção: rm_code guarda o CÓDIGO DE NEGÓCIO do RM (RA, CHAPA, CODTURMA...)
 * — nunca o InternalId, que é chave técnica e fica só como referência.
 */
export const idMappingRepository = {
  async findByRmCode(entityType: EntityType, rmCode: string): Promise<IdMapping | null> {
    const { rows } = await pgPool.query<IdMappingRow>(
      'SELECT * FROM id_mapping WHERE entity_type = $1 AND rm_code = $2',
      [entityType, rmCode],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  },

  /** Busca em lote — caminho rápido do worker antes de consultar o Toddle. */
  async findManyByRmCodes(entityType: EntityType, rmCodes: string[]): Promise<Map<string, IdMapping>> {
    const result = new Map<string, IdMapping>();
    if (rmCodes.length === 0) return result;
    const { rows } = await pgPool.query<IdMappingRow>(
      'SELECT * FROM id_mapping WHERE entity_type = $1 AND rm_code = ANY($2)',
      [entityType, rmCodes],
    );
    for (const row of rows) result.set(row.rm_code, mapRow(row));
    return result;
  },

  async findByToddleId(entityType: EntityType, toddleId: string): Promise<IdMapping | null> {
    const { rows } = await pgPool.query<IdMappingRow>(
      'SELECT * FROM id_mapping WHERE entity_type = $1 AND toddle_id = $2',
      [entityType, toddleId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  },

  /**
   * Upsert idempotente pela chave de negócio (entity_type + rm_code).
   * É o coração da garantia de "não duplicar registros".
   */
  async upsert(input: {
    entityType: EntityType;
    rmCode: string;
    toddleId: string;
    rmInternalId?: string | null;
  }): Promise<IdMapping> {
    const { rows } = await pgPool.query<IdMappingRow>(
      `INSERT INTO id_mapping (entity_type, rm_code, rm_internal_id, toddle_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (entity_type, rm_code) DO UPDATE
         SET toddle_id      = EXCLUDED.toddle_id,
             rm_internal_id = COALESCE(EXCLUDED.rm_internal_id, id_mapping.rm_internal_id),
             updated_at     = now()
       RETURNING *`,
      [input.entityType, input.rmCode, input.rmInternalId ?? null, input.toddleId],
    );
    return mapRow(rows[0]);
  },

  async listByType(entityType: EntityType): Promise<IdMapping[]> {
    const { rows } = await pgPool.query<IdMappingRow>(
      'SELECT * FROM id_mapping WHERE entity_type = $1 ORDER BY rm_code',
      [entityType],
    );
    return rows.map(mapRow);
  },
};
