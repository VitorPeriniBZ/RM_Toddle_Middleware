-- ============================================================
-- `audit_event` passa a ser APPEND-ONLY NO BANCO, não só por contrato.
--
-- A migration 006 criou a tabela dizendo "Sem UPDATE e sem DELETE por
-- contrato". Contrato em comentário é intenção; a partir do momento em que
-- existe uma TELA que muda agenda e propõe vínculo, a trilha de auditoria passa
-- a ser a única resposta para "quem mudou isso, e quando" — e a defesa precisa
-- estar ABAIXO da interface, não dentro dela.
--
-- Por que trigger e não REVOKE: o nome da role da aplicação varia por ambiente
-- (Coolify, docker-compose local, máquina de desenvolvimento), e um REVOKE
-- endereçado à role errada é uma proteção que não existe e parece existir. O
-- trigger vale para qualquer conexão, incluindo a minha no psql às 3h da manhã.
--
-- TRUNCATE entra junto: ele não dispara trigger de linha, apaga tudo e não
-- aparece em nenhum lugar. É o comando que destruiria a trilha inteira.
-- ============================================================

CREATE OR REPLACE FUNCTION audit_event_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'audit_event é append-only: % foi recusado. A trilha responde "quem mudou o quê, quando" '
        'e reescrevê-la destrói a única evidência que existe. Corrija com um NOVO evento.',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_event_sem_update ON audit_event;
CREATE TRIGGER audit_event_sem_update
    BEFORE UPDATE OR DELETE ON audit_event
    FOR EACH STATEMENT EXECUTE FUNCTION audit_event_append_only();

DROP TRIGGER IF EXISTS audit_event_sem_truncate ON audit_event;
CREATE TRIGGER audit_event_sem_truncate
    BEFORE TRUNCATE ON audit_event
    FOR EACH STATEMENT EXECUTE FUNCTION audit_event_append_only();
