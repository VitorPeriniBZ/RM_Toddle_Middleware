-- ============================================================
-- entity_type 'TODDLE_DEMO': registros que existem NO TODDLE e NÃO têm
-- contrapartida no RM — os 957 alunos de demonstração que vieram com o sandbox
-- (sourceId tipo "TD32IE6UYXZRWL", e-mails "<id>@example.com") e 1 registro
-- "TESTE-AMBIENTE" criado à mão.
--
-- Por que entram na id_mapping em vez de um arquivo solto: arquivar um aluno no
-- Toddle o torna INVISÍVEL em qualquer GET, inclusive filtrando por sourceId, e
-- não existe DELETE. Sem guardar o id antes, arquivar é irreversível por API —
-- foi o que aconteceu com 186 alunos em 31/07/2026. Aqui em escala 5x maior.
--
-- Tipo PRÓPRIO, e não STUDENT, de propósito: estes não são alunos da escola e
-- não devem aparecer em nenhuma contagem do Fluxo 1. `rm_code` recebe o
-- sourceId do Toddle (não há código de RM), o que é uma exceção consciente à
-- convenção da tabela — daí o tipo separado, para a exceção ficar visível.
-- ============================================================
ALTER TABLE id_mapping DROP CONSTRAINT IF EXISTS id_mapping_entity_type_chk;

ALTER TABLE id_mapping ADD CONSTRAINT id_mapping_entity_type_chk
    CHECK (entity_type IN ('STUDENT', 'STAFF', 'PARENT', 'COURSE',
                           'TEACHER_COURSE', 'SUBJECT', 'YEAR_GROUP',
                           'TODDLE_DEMO'));
