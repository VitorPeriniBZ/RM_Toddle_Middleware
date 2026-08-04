-- ============================================================
-- NÚCLEO MULTI-TENANT — o middleware deixa de ser de uma escola e passa a ser
-- produto white label vendido a várias.
--
-- POR QUE ISTO ENTRA AGORA, E NÃO "QUANDO HOUVER O SEGUNDO CLIENTE":
-- `tenant_id` não pode ser coluna opcional acrescentada depois. Todo índice
-- único, toda consulta e todo caminho de escrita precisam nascer escopados; do
-- contrário o primeiro cliente novo vira refactor de tudo, com risco de uma
-- escola ver dado da outra. Mesma razão para a origem: `rm_code` hoje é
-- implicitamente global e assume UM único RM.
--
-- O QUE ESTA MIGRATION FAZ E NÃO FAZ:
--   FAZ  — cria o modelo (tenant, campus, conexões, identidade, auditoria,
--          operações aprováveis) e escopa a id_mapping por tenant, migrando as
--          1.654 linhas existentes para o tenant da EAV. Nada é perdido.
--   NÃO FAZ — não muda comportamento de runtime. O código continua funcionando
--          com um tenant só (resolvido por TENANT_SLUG no .env). A troca para
--          resolução por requisição/job vem com a API.
--
-- Requer PostgreSQL 13+.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tenant e campus
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        TEXT NOT NULL UNIQUE,          -- identificador estável em URL/config
    nome        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT tenant_status_chk CHECK (status IN ('active', 'suspended'))
);

-- Campus é SUBORDINADO ao tenant: "uma escola com dois campi" é configuração,
-- não outro cliente. A EAV tem 1 (Infantil+Fund.I) e 2 (aeroporto).
CREATE TABLE IF NOT EXISTS campus (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    codigo_fonte TEXT NOT NULL,                -- CODFILIAL no RM
    nome         TEXT NOT NULL,
    em_escopo    BOOLEAN NOT NULL DEFAULT false,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT campus_uq UNIQUE (tenant_id, codigo_fonte)
);

-- ------------------------------------------------------------
-- 2. Conexões de integração
--
-- `secret_ref` é uma REFERÊNCIA a cofre/KMS, nunca a credencial. Token do
-- Toddle e senha do RM não entram nesta tabela: se vazar o banco, não vaza o
-- acesso aos sistemas do cliente. Hoje as credenciais estão no .env de um
-- deploy só; quando houver N escolas, cada conexão aponta para seu segredo.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_connection (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    provider     TEXT NOT NULL,                -- 'totvs_rm' | 'toddle'
    papel        TEXT NOT NULL,                -- 'source' | 'target'
    /* Identidade do ambiente remoto: organizationId do Toddle, coligada do RM.
       É a antiga target_instance_key, agora explícita e pertencente ao tenant. */
    instance_key TEXT NOT NULL,
    secret_ref   TEXT,                         -- caminho no cofre; NULL enquanto vier do .env
    ambiente     TEXT NOT NULL DEFAULT 'production',
    status       TEXT NOT NULL DEFAULT 'active',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ic_provider_chk  CHECK (provider IN ('totvs_rm', 'toddle')),
    CONSTRAINT ic_papel_chk     CHECK (papel IN ('source', 'target')),
    CONSTRAINT ic_ambiente_chk  CHECK (ambiente IN ('production', 'sandbox')),
    CONSTRAINT ic_status_chk    CHECK (status IN ('active', 'disabled')),
    CONSTRAINT ic_uq UNIQUE (tenant_id, provider, instance_key)
);

-- ------------------------------------------------------------
-- 3. Identidade e acesso
--
-- Google OIDC: a identidade estável é o `subject` (claim `sub`), NÃO o e-mail —
-- e-mail muda. E pertencer ao domínio do Workspace (claim `hd`) é autenticação,
-- não autorização: quem pode o quê vive em `membership`.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_identity (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider   TEXT NOT NULL DEFAULT 'google',
    subject    TEXT NOT NULL,
    email      TEXT,                            -- informativo; pode mudar
    nome       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT user_identity_uq UNIQUE (provider, subject)
);

CREATE TABLE IF NOT EXISTS membership (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_identity_id UUID NOT NULL REFERENCES user_identity(id) ON DELETE CASCADE,
    tenant_id        UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    campus_id        UUID REFERENCES campus(id) ON DELETE CASCADE,  -- NULL = todos
    papel            TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT membership_papel_chk CHECK (papel IN
        ('viewer', 'mapping_manager', 'integration_operator', 'approver', 'tenant_admin')),
    CONSTRAINT membership_uq UNIQUE (user_identity_id, tenant_id, campus_id, papel)
);

-- ------------------------------------------------------------
-- 4. Auditoria — APPEND-ONLY
--
-- Sem UPDATE e sem DELETE por contrato. Escrever no registro acadêmico de uma
-- escola exige poder responder "quem aprovou, quando, com base em quê".
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_event (
    id             BIGSERIAL PRIMARY KEY,
    tenant_id      UUID REFERENCES tenant(id) ON DELETE RESTRICT,
    ocorrido_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
    ator           TEXT NOT NULL,               -- 'user:<uuid>' | 'system/cli' | 'worker:<fila>'
    acao           TEXT NOT NULL,
    entidade       TEXT,
    entidade_id    TEXT,
    antes          JSONB,
    depois         JSONB,
    motivo         TEXT,
    correlacao_id  TEXT,
    resultado      TEXT
);
CREATE INDEX IF NOT EXISTS audit_event_tenant_idx ON audit_event (tenant_id, ocorrido_em DESC);
CREATE INDEX IF NOT EXISTS audit_event_correl_idx ON audit_event (correlacao_id);

-- ------------------------------------------------------------
-- 5. Operações aprováveis
--
-- Toda escrita no RM nasce aqui, nunca direto de um clique. `payload` é
-- CONGELADO na aprovação: mudou o payload, a configuração ou o estado lido do
-- RM, a aprovação perde validade e precisa de outra. `source_snapshot` guarda o
-- que foi lido do RM na prévia, para revalidar antes de gravar — sucesso HTTP
-- não é prova de resultado de negócio.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operation (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    campus_id       UUID REFERENCES campus(id) ON DELETE RESTRICT,
    tipo            TEXT NOT NULL,               -- ex.: 'rm.frequencia.lancar'
    estado          TEXT NOT NULL DEFAULT 'draft',
    payload         JSONB NOT NULL,
    source_snapshot JSONB,
    config_version  TEXT,
    idempotency_key TEXT NOT NULL,
    criado_por      UUID REFERENCES user_identity(id),
    resultado       JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT operation_estado_chk CHECK (estado IN
        ('draft', 'validated', 'approved', 'executing', 'succeeded', 'failed', 'needs_review')),
    CONSTRAINT operation_idem_uq UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS operation_fila_idx ON operation (tenant_id, estado, created_at);

CREATE TABLE IF NOT EXISTS approval (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id UUID NOT NULL REFERENCES operation(id) ON DELETE RESTRICT,
    approver_id  UUID NOT NULL REFERENCES user_identity(id),
    decisao      TEXT NOT NULL,
    motivo       TEXT,
    decidido_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT approval_decisao_chk CHECK (decisao IN ('approved', 'rejected')),
    /* Quem propõe não aprova a própria operação: garantido na aplicação, porque
       aqui não há acesso a operation.criado_por dentro do CHECK. */
    CONSTRAINT approval_uq UNIQUE (operation_id, approver_id)
);

-- ------------------------------------------------------------
-- 6. id_mapping escopada por tenant
--
-- As 1.654 linhas existentes (253 alunos, 185 classes, 109 teacher-courses,
-- 31 professores, 24 year groups, 1.033 registros de demo arquivados) são
-- migradas para o tenant da EAV. Nenhuma linha é apagada.
-- ------------------------------------------------------------
INSERT INTO tenant (slug, nome)
     VALUES ('eav', 'Escola Americana de Vitória')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO campus (tenant_id, codigo_fonte, nome, em_escopo)
SELECT t.id, v.codigo, v.nome, v.escopo
  FROM tenant t
  CROSS JOIN (VALUES ('1', 'Infantil + Fundamental I', false),
                     ('2', 'Aeroporto (Fund. II + Médio)', true)) AS v(codigo, nome, escopo)
 WHERE t.slug = 'eav'
ON CONFLICT (tenant_id, codigo_fonte) DO NOTHING;

-- A organização Toddle sandbox onde tudo foi criado até aqui.
INSERT INTO integration_connection (tenant_id, provider, papel, instance_key, ambiente)
SELECT t.id, 'toddle', 'target', '404045532130986859', 'sandbox'
  FROM tenant t WHERE t.slug = 'eav'
ON CONFLICT (tenant_id, provider, instance_key) DO NOTHING;

ALTER TABLE id_mapping ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
/* Origem: hoje há um RM só, mas a coluna nasce para que o segundo cliente não
   exija refactor. NULL = a origem padrão do tenant. */
ALTER TABLE id_mapping ADD COLUMN IF NOT EXISTS source_instance_key TEXT;
/* Mapeamento substituído por outro (troca de modelo, correção): preserva a
   cadeia histórica em vez de sobrescrever. */
ALTER TABLE id_mapping ADD COLUMN IF NOT EXISTS superseded_by UUID REFERENCES id_mapping(id);

UPDATE id_mapping SET tenant_id = (SELECT id FROM tenant WHERE slug = 'eav')
 WHERE tenant_id IS NULL;

ALTER TABLE id_mapping ALTER COLUMN tenant_id SET NOT NULL;

-- A chave de negócio passa a incluir o tenant: o MESMO RA em escolas diferentes
-- não colide, e uma consulta que esqueça o filtro não devolve dado de outra.
ALTER TABLE id_mapping DROP CONSTRAINT IF EXISTS id_mapping_rm_uq;
ALTER TABLE id_mapping ADD CONSTRAINT id_mapping_rm_uq
    UNIQUE (tenant_id, entity_type, rm_code, target_instance_key);

DROP INDEX IF EXISTS id_mapping_toddle_1to1_uq;
CREATE UNIQUE INDEX IF NOT EXISTS id_mapping_toddle_1to1_uq
    ON id_mapping (tenant_id, entity_type, toddle_id, target_instance_key)
    WHERE entity_type IN ('STUDENT', 'STAFF', 'PARENT');

DROP INDEX IF EXISTS id_mapping_lookup_idx;
CREATE INDEX IF NOT EXISTS id_mapping_lookup_idx
    ON id_mapping (tenant_id, entity_type, target_instance_key, state);
