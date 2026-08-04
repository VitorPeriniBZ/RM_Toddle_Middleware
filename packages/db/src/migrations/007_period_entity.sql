-- ============================================================
-- 007 — tipo PERIOD: o de-para entre a faixa de horário do RM e o período do
-- Toddle.
--
-- POR QUE ISTO EXISTE
--
-- A hora de uma aula lançada no Toddle não vem no registro de frequência
-- (medido em 04/08/2026: `startTime` nulo em 800 de 800). Ela vem do
-- `periodSet` do bell schedule, ligando `periodId` a `startTime`/`endTime`.
--
-- E `periodId` sozinho não determina a hora: nas grades de demonstração desta
-- organização, 9 dos 57 períodos aparecem em bell schedules diferentes com
-- horas diferentes. Criar períodos NOSSOS, um por faixa da grade do RM, torna a
-- relação 1:1 por construção.
--
-- `rm_code` recebe o sufixo do CODHOR do RM ('001'..'007'), que identifica a
-- faixa de forma estável: o CODHOR tem o formato <dia><022><faixa>, e o sufixo
-- mapeia 1:1 para (HORAINICIAL, HORAFINAL). Não é o IDHORARIOTURMA — este é por
-- turma-disciplina e por dia; a faixa é a mesma para todas.
--
-- POR QUE O `sourceId` DO TODDLE NÃO SERVE
--
-- `POST /public/v2/period` não aceita `sourceId`: o Toddle gera o dele
-- ('TDP-<id>'). Então o de-para tem de morar aqui — não há como recuperá-lo
-- consultando a API por uma chave nossa, ao contrário de aluno e turma.
-- Perder estas linhas é perder a identificação dos períodos que criamos.
-- ============================================================
ALTER TABLE id_mapping DROP CONSTRAINT IF EXISTS id_mapping_entity_type_chk;

ALTER TABLE id_mapping ADD CONSTRAINT id_mapping_entity_type_chk
    CHECK (entity_type IN ('STUDENT', 'STAFF', 'PARENT', 'COURSE',
                           'TEACHER_COURSE', 'SUBJECT', 'YEAR_GROUP',
                           'TODDLE_DEMO', 'PERIOD'));

COMMENT ON CONSTRAINT id_mapping_entity_type_chk ON id_mapping IS
    'PERIOD: rm_code = sufixo do CODHOR (001..007) = faixa de horário; '
    'toddle_id = periodId. O Toddle não aceita sourceId em POST /period, '
    'então este de-para é a única identificação dos períodos que criamos.';
