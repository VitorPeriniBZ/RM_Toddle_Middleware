-- =====================================================================
-- 011 — Separa EXECUÇÃO de APROVAÇÃO
--
-- ─── O ERRO QUE ISTO CORRIGE, E DE QUEM ELE É ───────────────────────────────
--
-- A migration 006 criou `operation` para "operação aprovável": tem
-- `criado_por`, `resultado`, `config_version`, `estado` com `draft`/`validated`/
-- `approved`/`needs_review`, e a tabela `approval` referenciando-a. O desenho era
-- claro.
--
-- Em 21/08/2026 eu passei a usar a MESMA tabela como registro de execução de job,
-- porque o CHECK já aceitava `executing`/`succeeded`/`failed` e "não precisou de
-- migration". Foi conveniência minha, e virou dívida na mesma semana.
--
-- São ciclos de vida diferentes:
--
--   execução   é um EVENTO: começou, terminou, N linhas, falhou. Append-only.
--   aprovação  é uma MÁQUINA DE ESTADOS: proposta -> aprovada/rejeitada.
--
-- Conflatar significa: colunas de aprovação nulas em ~99% das linhas, toda
-- consulta de aprovação varrendo runs, e — o que realmente dói — a tabela que
-- vai virar registro de auditoria de escrita em ERP de cliente carregando
-- telemetria técnica junto.
--
-- ─── POR QUE AGORA, E NÃO DEPOIS ────────────────────────────────────────────
--
-- Porque as duas tabelas estão VAZIAS neste momento, em dev e em produção — o
-- worker de produção ainda roda o código anterior ao registro de run. Zero linha
-- para migrar.
--
-- Depois do writer, `operation` passa a ser trilha de auditoria de escrita no
-- registro acadêmico de um cliente, e mexer nela deixa de ser refactor: vira
-- migração de dado legal. A janela é agora.
-- =====================================================================

-- 1. A execução ganha casa própria ------------------------------------------
CREATE TABLE IF NOT EXISTS job_run (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,

    /* `students.sync` | `staff.sync` | ... */
    tipo           TEXT NOT NULL,
    /* Chave única do run. É o jobId do BullMQ (ou o runId derivado), e é por ela
       que os lotes reencontram a linha para acumular contadores. */
    chave          TEXT NOT NULL,

    estado         TEXT NOT NULL DEFAULT 'executing',
    /* Contexto: trigger, escopo, lotesEsperados, a avaliação da guarda. */
    payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
    /* Contadores acumulados. `emEscopo` aqui é o que a guarda de desvio do run
       SEGUINTE compara. */
    resultado      JSONB NOT NULL DEFAULT '{}'::jsonb,
    config_version TEXT,

    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT job_run_estado_chk CHECK (estado IN ('executing', 'succeeded', 'failed')),
    CONSTRAINT job_run_chave_uq UNIQUE (tenant_id, chave)
);

/* "Como foi o último run deste tipo?" e "o que está preso em executing?" */
CREATE INDEX IF NOT EXISTS job_run_recente_idx
    ON job_run (tenant_id, tipo, created_at DESC);
CREATE INDEX IF NOT EXISTS job_run_estado_idx
    ON job_run (tenant_id, estado, updated_at DESC);

-- 2. Proveniência e pendências apontam para o RUN, não para a operação -------
--
-- Semanticamente é o run que escreveu a linha e o run que detectou a pendência.
-- Apontar para `operation` só funcionava porque `operation` estava fazendo o
-- papel de run.
ALTER TABLE rm_write_provenance DROP CONSTRAINT IF EXISTS rm_write_provenance_operation_id_fkey;
ALTER TABLE rm_write_provenance RENAME COLUMN operation_id TO run_id;
ALTER TABLE rm_write_provenance
    ADD CONSTRAINT rm_write_provenance_run_id_fkey
    FOREIGN KEY (run_id) REFERENCES job_run(id) ON DELETE SET NULL;
DROP INDEX IF EXISTS rwp_operation_idx;
CREATE INDEX IF NOT EXISTS rwp_run_idx ON rm_write_provenance (run_id);

ALTER TABLE write_pendency DROP CONSTRAINT IF EXISTS write_pendency_operation_id_fkey;
ALTER TABLE write_pendency RENAME COLUMN operation_id TO run_id;
ALTER TABLE write_pendency
    ADD CONSTRAINT write_pendency_run_id_fkey
    FOREIGN KEY (run_id) REFERENCES job_run(id) ON DELETE SET NULL;
DROP INDEX IF EXISTS wp_operation_idx;
CREATE INDEX IF NOT EXISTS wp_run_idx ON write_pendency (run_id);

-- 3. `operation` volta ao que a 006 desenhou: coisa a aprovar ----------------
--
-- Ganha o vínculo com o run que a PROPÔS. Sem isso, quem aprova vê "3.000
-- linhas" sem poder chegar à execução que produziu o número.
ALTER TABLE operation ADD COLUMN IF NOT EXISTS run_id UUID
    REFERENCES job_run(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS operation_run_idx ON operation (run_id);

/* Os três estados de execução saem do CHECK: não é mais papel desta tabela, e
   deixá-los permitiria a mesma confusão voltar em silêncio.

   Seguro porque a tabela está vazia — se houvesse linha em `executing`, este
   ALTER falharia, o que é o comportamento certo. */
ALTER TABLE operation DROP CONSTRAINT IF EXISTS operation_estado_chk;
ALTER TABLE operation ADD CONSTRAINT operation_estado_chk CHECK (estado IN
    ('draft', 'validated', 'needs_review', 'approved', 'rejected'));

COMMENT ON TABLE job_run IS
    'Execução de job: evento, append-only. Contadores em resultado. Ver migration 011.';
COMMENT ON TABLE operation IS
    'Operação que precisa de aprovação humana. Máquina de estados; approval registra a decisão. Ver migration 011.';
