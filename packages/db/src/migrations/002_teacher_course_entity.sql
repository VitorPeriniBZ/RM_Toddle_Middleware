-- ============================================================
-- Toddle 2.0: a EAV usa o modelo TeacherCourse. Adicionamos o
-- entity_type 'TEACHER_COURSE' ao CHECK da id_mapping para que o
-- Fluxo 2 (Toddle -> RM) possa mapear STURMADISC <-> teacher course.
-- Recria o CHECK nomeado incluindo o novo valor (idempotente).
-- ============================================================
ALTER TABLE id_mapping DROP CONSTRAINT IF EXISTS id_mapping_entity_type_chk;

ALTER TABLE id_mapping
    ADD CONSTRAINT id_mapping_entity_type_chk
    CHECK (entity_type IN (
        'STUDENT', 'STAFF', 'PARENT', 'COURSE', 'TEACHER_COURSE', 'SUBJECT', 'YEAR_GROUP'
    ));
