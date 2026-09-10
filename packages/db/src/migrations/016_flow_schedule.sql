-- ============================================================
-- A AGENDA SAI DO AMBIENTE E VAI PARA O BANCO.
--
-- Até aqui o horário de cada fluxo era variável de ambiente (STUDENTS_SYNC_CRON,
-- NOTA_SYNC_CRON) e o liga/desliga era NOTA_SYNC_ATIVO. Mudar qualquer um dos
-- três exigia editar o `.env` e REDEPLOYAR — e o deploy aqui é manual, sem
-- webhook. Uma tela de agendamento não pode ser construída em cima disso.
--
-- ─── PRECEDÊNCIA: UMA VIA, NUNCA DUAS ───────────────────────────────────────
--
-- Esta tabela é a VERDADE. O ambiente vira SEMENTE: se não existe linha para o
-- fluxo, ela é criada a partir do env na primeira subida (ver
-- `semearDoAmbiente` em apps/worker/src/agenda/reconciliar.ts) e, dali em
-- diante, o env NUNCA MAIS é lido para aquele fluxo.
--
-- Não é preciosismo. Se o env sobrescrevesse quando presente, o próximo deploy
-- com `NOTA_SYNC_ATIVO=false` desligaria em silêncio o que a tela ligou — com a
-- tela mostrando "ligado" por cima. É a mesma classe de bug da definição
-- duplicada de scheduler, agora com uma interface mentindo.
--
-- ─── `ativo` NASCE `false`, E ISSO É REQUISITO DE SEGURANÇA ─────────────────
--
-- O env.ts documenta o default `false` de NOTA_SYNC_ATIVO assim: "escrita
-- automática em registro acadêmico legal não pode chegar numa escola nova por
-- herança de default". A propriedade tem de sobreviver à mudança de lugar:
-- LINHA AUSENTE = FLUXO DESLIGADO, e linha nova nasce desligada. Ligar é sempre
-- ato explícito de alguém, registrado em audit_event.
--
-- ─── O QUE NÃO ENTRA AQUI ───────────────────────────────────────────────────
--
-- Nome de fila, nome de job, payload. Só `(cron, timezone, ativo)` por
-- `flow_key`. O catálogo que traduz flow_key -> fila/job continua em
-- packages/queues/src/fluxos.ts, no código: uma tabela que definisse fila e
-- payload transformaria a tela numa máquina de criar job arbitrário no Redis.
--
-- Requer PostgreSQL 13+.
-- ============================================================

CREATE TABLE IF NOT EXISTS flow_schedule (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,

    /* Chave estável do fluxo, do catálogo em packages/queues/src/fluxos.ts.
       É TAMBÉM o id do Job Scheduler no BullMQ — e por isso não pode derivar do
       cron: key derivada do cron faria cada edição criar um scheduler novo e
       ABANDONAR o velho, ativo, invisível e disparando para sempre. */
    flow_key     TEXT NOT NULL,

    cron         TEXT NOT NULL,
    /* Nome IANA, nunca offset fixo ("-03:00"). O Brasil não tem horário de verão
       desde 2019; se voltar a ter, um nome IANA continua correto e um offset
       cravado passa a estar errado por meio ano. */
    timezone     TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    ativo        BOOLEAN NOT NULL DEFAULT false,

    /* Sobe a cada mudança de intenção. O worker compara com `revisao_aplicada`
       para não regravar o mesmo scheduler a cada volta do poll, e para nunca
       aplicar uma revisão velha em cima de uma nova. */
    revisao      BIGINT NOT NULL DEFAULT 1,

    /* ─── Estado de APLICAÇÃO, separado da intenção ─────────────────────────
       A intenção mora no Postgres; o scheduler vive no Redis. As duas coisas
       divergem — Redis reiniciado sem persistência, worker fora do ar, erro na
       aplicação — e a tela precisa MOSTRAR a divergência em vez de exibir a
       intenção como se fosse fato. Estas três colunas são o que ela lê. */
    revisao_aplicada BIGINT,
    aplicada_em      TIMESTAMPTZ,
    erro_ao_aplicar  TEXT,

    /* Quem mudou. NULL = semeado a partir do ambiente, sem gente envolvida. */
    atualizado_por UUID REFERENCES user_identity(id),

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT flow_schedule_uq UNIQUE (tenant_id, flow_key),
    CONSTRAINT flow_schedule_cron_chk CHECK (length(trim(cron)) > 0),
    /* Cinco campos. Seis incluiria SEGUNDOS, e nenhum fluxo aqui roda por
       segundo — a validação completa (intervalo mínimo, prévia dos disparos)
       está em packages/config/src/cron.ts, mas o banco recusa o grosseiro. */
    CONSTRAINT flow_schedule_cron_campos_chk
        CHECK (array_length(regexp_split_to_array(trim(cron), '\s+'), 1) = 5)
);

/* O worker lê a agenda inteira do tenant a cada volta do poll (são 3 linhas), e
   a tela lê a mesma coisa. Índice pelo caminho de acesso real. */
CREATE INDEX IF NOT EXISTS flow_schedule_tenant_idx ON flow_schedule (tenant_id, flow_key);
