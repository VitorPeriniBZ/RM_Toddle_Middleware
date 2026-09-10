-- =====================================================================
-- 015 — tipo ASSESSMENT: o de-para entre a AVALIAÇÃO do RM e o
--       assignment do Toddle
--
-- ─── POR QUE ESTE TIPO PRECISA EXISTIR ───────────────────────────────
--
-- A nota da ETAPA no RM é calculada por fórmula (`SETAPAS.CODFORMULANOTA`)
-- e o `EduNotaEtapaData` DESCARTA qualquer valor que se mande nela — medido
-- em 09/09/2026, seis formatos, todos com `ok=true` e releitura `0.0000`.
--
-- A nota que se pode escrever é a da AVALIAÇÃO: `SNotas`, chaveada por
-- `CODCOLIGADA + CODPROVA + CODETAPA + TIPOETAPA + IDTURMADISC + RA`. E o
-- `CODPROVA` é a peça que faltava no de-para: sem ele, uma nota do Toddle
-- não tem endereço no RM.
--
-- ─── A CHAVE, E POR QUE ELA É COMPOSTA ───────────────────────────────
--
-- `rm_code` recebe `IDTURMADISC:CODETAPA:CODPROVA`, não só o CODPROVA.
--
-- O motivo é que `CODPROVA` é um `xs:short` sequencial POR turma-disciplina
-- e etapa: existe uma "prova 1" em cada uma das 186 turmas-disciplina. Um
-- `rm_code` só com o número colidiria na `id_mapping_rm_uq` na segunda turma
-- que tivesse avaliação — e o de-para passaria a apontar a prova da turma
-- errada, silenciosamente.
--
-- `toddle_id` recebe o `id` do assignment.
--
-- ─── O QUE ISSO NÃO RESOLVE ──────────────────────────────────────────
--
-- Escrever `SNotas` NÃO recalcula a nota da etapa: medido, inclusive
-- tentando tocar o `SNotaEtapa` depois e esperando 15s. Fechar a etapa é um
-- processo do RM que nenhum DataServer disponível dispara. Este de-para
-- entrega a nota da avaliação; o boletim continua sendo ato humano.
-- =====================================================================
ALTER TABLE id_mapping DROP CONSTRAINT IF EXISTS id_mapping_entity_type_chk;

ALTER TABLE id_mapping ADD CONSTRAINT id_mapping_entity_type_chk
    CHECK (entity_type IN ('STUDENT', 'STAFF', 'PARENT', 'COURSE',
                           'TEACHER_COURSE', 'SUBJECT', 'YEAR_GROUP',
                           'TODDLE_DEMO', 'PERIOD', 'GRADING_PERIOD',
                           'ASSESSMENT'));

COMMENT ON CONSTRAINT id_mapping_entity_type_chk ON id_mapping IS
    'PERIOD: rm_code = sufixo do CODHOR (faixa de horário). '
    'GRADING_PERIOD: rm_code = CODETAPA da etapa de NOTA; a correspondência com o '
    'grading period do Toddle é por ORDINAL, não por data — as janelas divergem. '
    'ASSESSMENT: rm_code = IDTURMADISC:CODETAPA:CODPROVA (composta porque CODPROVA '
    'é sequencial por turma-disciplina, e só o número colidiria entre turmas); '
    'toddle_id = id do assignment.';
