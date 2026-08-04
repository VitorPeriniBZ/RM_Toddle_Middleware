-- ============================================================
-- Uma linha de id_mapping passa a significar "esta entidade do RM NESTE
-- destino Toddle", não apenas "esta entidade do RM".
--
-- Por quê: a organização Toddle atual é um sandbox descartável que será
-- recriada, e a estrutura acadêmica (year groups, grades, currículos, períodos)
-- é SOMENTE LEITURA na API — quem cria é a escola pelo portal. Logo todo id do
-- Toddle que guardamos tem prazo de validade, e até aqui a tabela não tinha
-- como perceber a troca: ids continuavam "válidos" localmente depois de deixar
-- de existir no destino.
--
-- Segunda mudança, igualmente importante: ARQUIVAR NUNCA APAGA A LINHA.
-- O GET /students do Toddle NÃO devolve aluno arquivado (nem filtrando por
-- sourceId) e não existe DELETE de aluno. Portanto o toddle_id guardado aqui é
-- o ÚNICO caminho de volta para um registro arquivado. Em 2026-07-31 arquivamos
-- 186 alunos fora de escopo E apagamos as linhas — o que destruiu esse handle.
-- Não repetir: marcar state='archived' e preservar a linha.
-- ============================================================

ALTER TABLE id_mapping
    ADD COLUMN IF NOT EXISTS target_instance_key   TEXT,
    ADD COLUMN IF NOT EXISTS state                 TEXT NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS archived_at           TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS archive_reason        TEXT,
    ADD COLUMN IF NOT EXISTS last_seen_in_scope_at TIMESTAMPTZ,
    -- Só para YEAR_GROUP: em qual currículo do Toddle aquele yearGroupId vive.
    -- A organização tem DOIS currículos (MYP e UBD) com year groups de nomes
    -- DUPLICADOS entre si (dois "Batch of 2028", dois "Year 1"), então o id
    -- sozinho não diz a qual escada pertence. Sem esta coluna o mapeamento é
    -- inauditável.
    ADD COLUMN IF NOT EXISTS curriculum_id         TEXT;

-- Backfill: as linhas que já existem foram criadas contra a organização
-- sandbox "Escola Americana de Vitória_Sandbox". Registrado explicitamente em
-- vez de deixar NULL, para que a validação de destino tenha o que comparar.
UPDATE id_mapping
   SET target_instance_key = '404045532130986859'
 WHERE target_instance_key IS NULL;

ALTER TABLE id_mapping ALTER COLUMN target_instance_key SET NOT NULL;

ALTER TABLE id_mapping
    ADD CONSTRAINT id_mapping_state_chk CHECK (state IN ('active', 'archived'));

-- A chave de negócio agora inclui o destino: o MESMO RA pode ter mapeamento no
-- sandbox e na organização final, sem colidir.
ALTER TABLE id_mapping DROP CONSTRAINT IF EXISTS id_mapping_rm_uq;
ALTER TABLE id_mapping ADD CONSTRAINT id_mapping_rm_uq
    UNIQUE (entity_type, rm_code, target_instance_key);

-- Proteção 1:1 (dois RAs no mesmo registro do Toddle) também passa a ser por
-- destino. Continua parcial: YEAR_GROUP e as entidades de agrupamento são N:1
-- por natureza — várias turmas do RM apontam para o mesmo year group.
DROP INDEX IF EXISTS id_mapping_toddle_1to1_uq;
CREATE UNIQUE INDEX IF NOT EXISTS id_mapping_toddle_1to1_uq
    ON id_mapping (entity_type, toddle_id, target_instance_key)
    WHERE entity_type IN ('STUDENT', 'STAFF', 'PARENT');

-- Consultas do sync filtram por destino + estado.
CREATE INDEX IF NOT EXISTS id_mapping_lookup_idx
    ON id_mapping (entity_type, target_instance_key, state);
