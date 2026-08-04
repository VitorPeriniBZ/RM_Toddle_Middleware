-- ============================================================
-- Tabela de mapeamento de IDs entre TOTVS RM e Toddle.
-- É a fonte da verdade da correspondência entre os dois sistemas
-- e a base da idempotência (upsert por entity_type + rm_code).
-- Requer PostgreSQL 13+ (gen_random_uuid nativo).
-- ============================================================
CREATE TABLE IF NOT EXISTS id_mapping (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type     TEXT NOT NULL,
    rm_code         TEXT NOT NULL,          -- código de NEGÓCIO do RM (RA, CHAPA, CODTURMA...)
    rm_internal_id  TEXT,                   -- InternalId do TTALK (informativo; nunca montar na mão)
    toddle_id       TEXT NOT NULL,          -- todo ID do Toddle é String
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT id_mapping_entity_type_chk
        CHECK (entity_type IN ('STUDENT', 'STAFF', 'PARENT', 'COURSE', 'SUBJECT', 'YEAR_GROUP')),

    -- Idempotência: um código de negócio do RM só pode apontar para UM registro no Toddle
    CONSTRAINT id_mapping_rm_uq     UNIQUE (entity_type, rm_code),
    -- Proteção contra corrupção do mapeamento (dois códigos RM no mesmo registro Toddle)
    CONSTRAINT id_mapping_toddle_uq UNIQUE (entity_type, toddle_id)
);
