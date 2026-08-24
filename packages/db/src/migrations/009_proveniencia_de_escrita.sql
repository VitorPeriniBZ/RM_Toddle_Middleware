-- =====================================================================
-- 009 — Proveniência de escrita no RM
--
-- A única defesa contra a integração apagar trabalho humano.
--
-- ─── O PROBLEMA ─────────────────────────────────────────────────────────────
--
-- O RM não é um destino vazio. Medido:
--
--   21.300 ausências lançadas à mão (SFREQUENCIA, ano letivo, dois campi)
--   ~10.000 notas lançadas à mão (SNOTAETAPA)
--   12.166 conteúdos de aula escritos à mão (SPLANOAULA.CONTEUDOEFETIVO)
--
-- O `SaveRecord` do wsDataServer é upsert por chave e NÃO diz se inseriu ou
-- atualizou. Então, sem saber o que já escrevemos, toda escrita é uma aposta:
-- pode estar criando um registro novo ou pisando no lançamento de um professor.
--
-- ─── A REGRA QUE ESTA TABELA VIABILIZA ──────────────────────────────────────
--
--   Nunca altere no RM um valor que a integração não escreveu.
--
-- Concretamente, antes de cada escrita: leia o estado atual no RM (por Sentença,
-- que é o único caminho que traz autoria) e cruze com esta tabela.
--
--   RM vazio            + sem proveniência  -> ESCREVER
--   RM preenchido       + proveniência nossa -> ATUALIZAR (é nosso)
--   RM preenchido igual + qualquer coisa     -> NADA A FAZER
--   RM preenchido       + SEM proveniência   -> CONFLITO. Humano escreveu. NÃO TOCAR.
--
-- O último caso é o que importa: ele vira pendência de revisão, nunca
-- sobrescrita silenciosa.
--
-- ─── POR QUE `campo` EXISTE, E NÃO SÓ A LINHA ───────────────────────────────
--
-- Para frequência, a granularidade é a LINHA: a integração cria o registro de
-- ausência, então "linha nossa" faz sentido e `campo` fica NULL.
--
-- Para PLANO DE AULA não funciona. As 22.367 linhas de `SPLANOAULA` são
-- pré-criadas pela grade horária — nenhuma é nossa, e escrever é UPDATE de linha
-- da escola. A regra por linha bloquearia 100% das escritas; ignorá-la
-- sobrescreveria 12.166 conteúdos humanos. Lá a granularidade é o CAMPO:
-- `CONTEUDOEFETIVO` pode ser nosso enquanto `CONTEUDO` (a ementa) nunca é.
--
-- Uma tabela com `campo` nullable atende os dois sem ramificar o modelo.
--
-- ─── ESTADO ATUAL, NÃO HISTÓRICO ────────────────────────────────────────────
--
-- Uma linha por chave, atualizada no lugar. A pergunta que a regra faz é "a
-- ÚLTIMA escrita foi nossa?", e para isso o estado atual basta. O histórico de
-- execuções vive em `operation` (migration 006), e `operation_id` liga os dois —
-- então dá para responder "que run escreveu isto" sem duplicar histórico aqui.
-- =====================================================================

CREATE TABLE IF NOT EXISTS rm_write_provenance (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,

    /* 'FREQUENCIA' | 'NOTA' | 'PLANO_AULA' — o que foi escrito. */
    entidade      TEXT NOT NULL,

    /* Chave natural NO RM, montada pelo domínio (ex.: chaveNaturalRm da
       frequência = codColigada|idHorarioTurma|idTurmaDisc|ra|data). É a mesma
       chave que dá idempotência ao job, de propósito: uma chave só para as duas
       responsabilidades evita que elas divirjam. */
    chave_natural TEXT NOT NULL,

    /* NULL = a linha inteira é nossa (frequência, nota).
       Preenchido = só este campo é nosso (plano de aula: 'CONTEUDOEFETIVO'). */
    campo         TEXT,

    /* Hash do valor que ESCREVEMOS. Permite três coisas que o `escrito_em` não
       dá: saber que o RM ainda tem o que deixamos (ninguém editou por fora),
       evitar reescrever valor idêntico, e detectar edição humana POSTERIOR à
       nossa — proveniência nossa + hash divergente = alguém mexeu depois. */
    payload_hash  TEXT NOT NULL,

    /* PK do registro no RM, quando o SaveRecord a devolve. Nullable porque não
       devolve sempre, e a regra não depende dela. */
    pk_rm         TEXT,

    /* Que execução escreveu. ON DELETE SET NULL: perder o histórico de runs não
       pode apagar a proveniência, que é o que protege o dado do professor. */
    operation_id  UUID REFERENCES operation(id) ON DELETE SET NULL,

    escrito_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT rwp_entidade_chk CHECK (entidade IN ('FREQUENCIA', 'NOTA', 'PLANO_AULA'))
);

/* A chave da regra. `coalesce` no `campo` porque NULL não participa de UNIQUE em
   Postgres — sem isso, duas linhas com campo NULL para a mesma chave natural
   conviveriam, e a pergunta "isto é nosso?" passaria a ter duas respostas. */
CREATE UNIQUE INDEX IF NOT EXISTS rwp_chave_uq
    ON rm_write_provenance (tenant_id, entidade, chave_natural, coalesce(campo, ''));

/* Para o writer resolver um lote inteiro numa consulta, em vez de N. */
CREATE INDEX IF NOT EXISTS rwp_lote_idx
    ON rm_write_provenance (tenant_id, entidade, chave_natural);

/* Para responder "o que este run escreveu no RM?" — a lista de reversão. */
CREATE INDEX IF NOT EXISTS rwp_operation_idx
    ON rm_write_provenance (operation_id);
