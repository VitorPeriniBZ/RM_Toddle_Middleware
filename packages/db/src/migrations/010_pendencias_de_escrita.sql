-- =====================================================================
-- 010 — Fila de pendências de escrita
--
-- Onde aterra o que a integração se RECUSOU a escrever no RM.
--
-- ─── POR QUE UMA TABELA, E NÃO `operation` / `approval` ─────────────────────
--
-- `operation` (migration 006) é por EXECUÇÃO, e `approval` aprova uma operação
-- inteira, com `approver_id`. Os dois modelam "autorizar este lote a rodar".
--
-- Pendência é outra coisa: é por REGISTRO, e a decisão não é "pode rodar?" mas
-- "o que fazer com esta aula específica, cujo conteúdo o professor escreveu no
-- RM e a integração quer sobrescrever?". Um run gera centenas; forçá-las em
-- `operation` misturaria duas granularidades na mesma tabela e tornaria o
-- `npm run runs` ilegível.
--
-- `operation_id` liga as duas: dá para perguntar "que run detectou isto".
--
-- ─── O QUE ATERRA AQUI ──────────────────────────────────────────────────────
--
-- Os três vereditos de `decidirEscrita` que exigem olho humano:
--
--   CONFLITO_HUMANO       o RM tem valor diferente e a autoria não é nossa
--   EDITADO_POR_FORA      escrevemos, mas alguém editou no RM depois
--   REMOCAO_PEDE_HUMANO   saiu do Toddle e existe no RM — DELETE nunca é inferido
--
-- Nenhum é erro do sistema. São decisões que pertencem a uma pessoa, porque do
-- outro lado há 21.300 ausências, ~10.000 notas e 12.166 conteúdos de aula
-- lançados à mão por professores.
--
-- ─── A DECISÃO DE DESENHO QUE FAZ OU QUEBRA ESTA FILA ───────────────────────
--
-- Uma linha por CHAVE, não por detecção.
--
-- O cron roda 4x ao dia. Um conflito que persiste seria redetectado ~28 vezes por
-- semana; inserir a cada passada faria a fila crescer sem limite e, pior, faria
-- uma pendência antiga parecer 28 problemas diferentes. Fila que mente sobre
-- volume é fila que ninguém abre — o mesmo destino do alerta que grita por nada.
--
-- Então: UNIQUE por chave, e a redetecção faz UPSERT incrementando `vezes_vista`.
--
-- ─── E A PARTE MAIS FÁCIL DE ERRAR: REABRIR ────────────────────────────────
--
-- Se a redetecção reabrisse tudo, resolver seria inútil: a pendência voltaria em
-- 6 horas e a fila viraria ruído permanente.
--
-- Mas ignorar toda redetecção também está errado: se o professor mudou o valor no
-- Toddle, é um conflito NOVO sobre a mesma aula, e quem decidiu antes decidiu
-- sobre outro dado.
--
-- A regra é o `hash_desejado`: pendência resolvida só reabre se o valor desejado
-- MUDOU. Mesmo valor, mesma decisão — fica resolvida e só o `visto_em` avança.
-- Isso é comportamento de rastreador de issues, e é deliberado.
-- =====================================================================

CREATE TABLE IF NOT EXISTS write_pendency (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,

    entidade      TEXT NOT NULL,
    /* Mesma chave natural da proveniência e da idempotência do job. Uma chave
       para as três responsabilidades, de propósito: chaves paralelas divergem. */
    chave_natural TEXT NOT NULL,
    /* NULL = a linha inteira. Preenchido = o campo em disputa (ex.:
       'CONTEUDOEFETIVO'), porque no plano de aula a linha é da escola. */
    campo         TEXT,

    veredito      TEXT NOT NULL,
    /* Frase pronta, vinda de `Decisao.porque`. Quem abre a fila precisa entender
       sem ler código. */
    porque        TEXT NOT NULL,

    /* Os dois lados do conflito, para a decisão ser tomável sem abrir o RM nem o
       Toddle. Valores de negócio ('A'/'P', nota, conteúdo de aula) — NUNCA o
       CPF do autor, que a leitura do RM já descarta na origem. */
    valor_desejado TEXT,
    valor_no_rm    TEXT,
    /* É por ele que se decide reabrir. Ver o cabeçalho. */
    hash_desejado  TEXT NOT NULL,

    /* id do registro na origem (Toddle), para rastrear até a tela do professor. */
    origem_id     TEXT,

    estado        TEXT NOT NULL DEFAULT 'aberta',
    /* O que a pessoa decidiu, em texto livre. Não há enum: as saídas legítimas
       são muitas (corrigi no RM, corrigi no Toddle, é histórico, ignorar) e um
       enum apertado viraria "outros" na primeira semana. */
    resolucao     TEXT,
    resolvido_por TEXT,
    resolvido_em  TIMESTAMPTZ,

    /* Que execução detectou primeiro. SET NULL para não perder a pendência junto
       com o histórico de runs. */
    operation_id  UUID REFERENCES operation(id) ON DELETE SET NULL,

    detectada_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
    visto_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
    /* Quantas passadas já viram isto. Separa "apareceu agora" de "está aí há
       três semanas", que pedem urgências diferentes. */
    vezes_vista   INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT wp_entidade_chk CHECK (entidade IN ('FREQUENCIA', 'NOTA', 'PLANO_AULA')),
    CONSTRAINT wp_veredito_chk CHECK (veredito IN
        ('CONFLITO_HUMANO', 'EDITADO_POR_FORA', 'REMOCAO_PEDE_HUMANO')),
    CONSTRAINT wp_estado_chk CHECK (estado IN ('aberta', 'resolvida', 'ignorada')),
    /* Resolvida sem quem/quando resolveu é pendência que ninguém responde por. */
    CONSTRAINT wp_resolucao_chk CHECK (
        estado = 'aberta' OR (resolvido_em IS NOT NULL AND resolvido_por IS NOT NULL)
    )
);

/* Uma linha por chave. `coalesce` no campo pelo mesmo motivo da proveniência:
   NULL não participa de UNIQUE em Postgres, e sem isso a mesma aula teria duas
   pendências indistinguíveis. */
CREATE UNIQUE INDEX IF NOT EXISTS wp_chave_uq
    ON write_pendency (tenant_id, entidade, chave_natural, coalesce(campo, ''));

/* A consulta do dia a dia: o que está aberto, mais recente primeiro. */
CREATE INDEX IF NOT EXISTS wp_fila_idx
    ON write_pendency (tenant_id, estado, visto_em DESC);

/* "O que este run recusou?" */
CREATE INDEX IF NOT EXISTS wp_operation_idx
    ON write_pendency (operation_id);
