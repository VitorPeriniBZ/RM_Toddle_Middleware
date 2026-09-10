-- ============================================================
-- `id_mapping` deixa de aceitar DELETE.
--
-- ─── O INCIDENTE QUE ISTO IMPEDE DE REPETIR ─────────────────────────────────
--
-- Em 31/07/2026, 186 alunos fora de escopo foram arquivados no Toddle E suas
-- linhas foram APAGADAS daqui. O Toddle não devolve aluno arquivado no
-- GET /students — nem filtrando por sourceId — e não tem DELETE de aluno. O
-- `toddle_id` guardado nesta tabela era o ÚNICO caminho de volta para aqueles
-- registros, e o DELETE destruiu esse handle.
--
-- A migration 004 corrigiu o COMPORTAMENTO (arquivar marca `state='archived'` e
-- preserva a linha). O que faltava era a defesa: hoje o repositório não emite
-- nenhum DELETE, mas está sendo construída uma TELA de de-para. Se existe uma
-- tela, um dia alguém clica — e a proteção tem de estar embaixo dela.
--
-- Arquivar continua livre: é UPDATE, não DELETE. Substituir também: a coluna
-- `superseded_by` (migration 006) existe para preservar a cadeia histórica em
-- vez de sobrescrever.
--
-- ─── E SE UMA LINHA PRECISAR MESMO SAIR? ────────────────────────────────────
--
-- `ALTER TABLE id_mapping DISABLE TRIGGER id_mapping_sem_delete`, apagar, e
-- reabilitar — três comandos deliberados, no psql, por alguém que sabe o que
-- está fazendo. É exatamente o atrito que se quer: nunca por acidente, nunca
-- por uma rota HTTP.
-- ============================================================

CREATE OR REPLACE FUNCTION id_mapping_sem_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'DELETE em id_mapping é recusado. O toddle_id guardado aqui é o único caminho de volta '
        'para um registro arquivado no Toddle (o GET /students não devolve arquivado, nem por '
        'sourceId) — apagar a linha destrói o handle, como aconteceu com 186 alunos em 31/07/2026. '
        'Para tirar de escopo use state=''archived''; para substituir, superseded_by.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS id_mapping_sem_delete ON id_mapping;
CREATE TRIGGER id_mapping_sem_delete
    BEFORE DELETE ON id_mapping
    FOR EACH STATEMENT EXECUTE FUNCTION id_mapping_sem_delete();

DROP TRIGGER IF EXISTS id_mapping_sem_truncate ON id_mapping;
CREATE TRIGGER id_mapping_sem_truncate
    BEFORE TRUNCATE ON id_mapping
    FOR EACH STATEMENT EXECUTE FUNCTION id_mapping_sem_delete();
