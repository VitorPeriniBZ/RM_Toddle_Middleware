-- ============================================================
-- 008 — tipo GRADING_PERIOD: o de-para entre a etapa de nota do RM e o
-- grading period do Toddle.
--
-- POR QUE EXISTE
--
-- `POST /public/v2/term-grades` exige `gradingPeriodId`. O RM identifica o
-- trimestre por `CODETAPA` (1, 2, 3 com `TIPOETAPA='N'`), e o Toddle por um id
-- opaco. Sem de-para, não há como dizer em qual coluna do boletim a nota entra.
--
-- A CORRESPONDÊNCIA É POR ORDINAL, NÃO POR DATA — e isso é deliberado
--
-- As janelas não batem, medido em 05/08/2026:
--
--   Toddle T1   21/11/2025 → 22/06/2026     RM etapa 1   03/02 → 15/05
--   Toddle T2   23/06      → 22/09/2026     RM etapa 2   18/05 → 04/09
--   Toddle T3   23/09      → 20/11/2026     RM etapa 3   09/09 → 11/12
--
-- O T1 do Toddle engloba o 1º trimestre inteiro do RM E um mês do 2º. A causa é
-- o ano acadêmico do Toddle ser de hemisfério norte (nov→nov) enquanto o ano
-- letivo brasileiro é fev→dez — a mesma raiz das três semanas de dezembro que
-- não cabem no Toddle.
--
-- Decisão da escola em 06/08/2026: mapear por ORDEM (etapa 1 → T1, 2 → T2,
-- 3 → T3). Funciona porque o Toddle usa o `gradingPeriodId` que enviamos, não a
-- data. O efeito colateral aceito é a tela mostrar "Term 1: 21/11/2025 a
-- 22/06/2026" para uma nota do trimestre fevereiro–maio.
--
-- A correção de verdade é ajustar as datas dos terms no portal do Toddle. Não é
-- possível pela API: só existe `GET /public/v2/grading-periods`, sem POST nem PUT.
--
-- `rm_code` recebe o CODETAPA ('1', '2', '3'); `toddle_id` o gradingPeriodId.
-- ============================================================
ALTER TABLE id_mapping DROP CONSTRAINT IF EXISTS id_mapping_entity_type_chk;

ALTER TABLE id_mapping ADD CONSTRAINT id_mapping_entity_type_chk
    CHECK (entity_type IN ('STUDENT', 'STAFF', 'PARENT', 'COURSE',
                           'TEACHER_COURSE', 'SUBJECT', 'YEAR_GROUP',
                           'TODDLE_DEMO', 'PERIOD', 'GRADING_PERIOD'));

COMMENT ON CONSTRAINT id_mapping_entity_type_chk ON id_mapping IS
    'PERIOD: rm_code = sufixo do CODHOR (faixa de horário). '
    'GRADING_PERIOD: rm_code = CODETAPA da etapa de NOTA; a correspondência com o '
    'grading period do Toddle é por ORDINAL, não por data — as janelas divergem.';
