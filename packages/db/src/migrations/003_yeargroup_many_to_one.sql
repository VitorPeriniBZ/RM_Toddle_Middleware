-- ============================================================
-- YEAR_GROUP é N:1 — várias turmas do RM apontam para o MESMO year group
-- do Toddle (ex.: EAVHS10IA e EAVHS10IB são ambas "Grade 10"). A constraint
-- id_mapping_toddle_uq (entity_type, toddle_id) da 001 barrava isso.
--
-- Para STUDENT/STAFF/PARENT a unicidade do toddle_id continua sendo uma
-- proteção real contra corrupção do mapeamento (dois RAs no mesmo aluno do
-- Toddle) e é mantida via índice único PARCIAL. As entidades de agrupamento
-- (YEAR_GROUP, COURSE, TEACHER_COURSE, SUBJECT) ficam livres para N:1.
--
-- Obs.: a 001 também não listava TEACHER_COURSE no CHECK de entity_type,
-- embora ENTITY_TYPES no código já o inclua — corrigido aqui.
-- ============================================================
ALTER TABLE id_mapping DROP CONSTRAINT IF EXISTS id_mapping_toddle_uq;

CREATE UNIQUE INDEX IF NOT EXISTS id_mapping_toddle_1to1_uq
    ON id_mapping (entity_type, toddle_id)
    WHERE entity_type IN ('STUDENT', 'STAFF', 'PARENT');

ALTER TABLE id_mapping DROP CONSTRAINT IF EXISTS id_mapping_entity_type_chk;

ALTER TABLE id_mapping ADD CONSTRAINT id_mapping_entity_type_chk
    CHECK (entity_type IN ('STUDENT', 'STAFF', 'PARENT', 'COURSE',
                           'TEACHER_COURSE', 'SUBJECT', 'YEAR_GROUP'));
