-- ============================================================
-- TEMPO QUASE REAL: os detectores de mudança.
--
-- Até aqui, nota lançada no Toddle esperava a próxima meia hora para chegar ao
-- RM, falta lançada esperava as 23:00, e aluno alterado no RM esperava o próximo
-- dos quatro horários do dia. Nenhuma das duas pontas avisa quando algo muda —
-- o Toddle não tem webhook, e o RM só alcança fora por Fórmula Visual que
-- ninguém configurou —, então o jeito de encurtar a espera é PERGUNTAR com
-- frequência, e perguntar barato: "mudou algo desde a última vez?".
--
-- Cada detector faz essa pergunta no seu intervalo e, quando a resposta é sim,
-- dispara o fluxo que JÁ EXISTE — com os mesmos guardas de escrita, a mesma
-- aprovação e o mesmo `job_run`. O detector não escreve em lugar nenhum.
--
-- ─── POR QUE UMA TABELA SEPARADA DA `flow_schedule` ─────────────────────────
--
-- A agenda é cron de cinco campos com intervalo mínimo de 15 min, e a folga
-- entre fluxos que disputam o Toddle é verificada nela. Um detector de minuto
-- em minuto não cabe nisso, e enfiá-lo lá obrigaria a afrouxar justamente as
-- guardas que protegem a cota do Toddle. Aqui a proteção é outra: o detector
-- pergunta pouco (1–2 chamadas por volta) e o limitador compartilhado
-- (limitadorDeTaxa.ts) segura tudo o que ele dispara.
--
-- ─── `ativo` NASCE `false` — MESMA REGRA DA 016 ─────────────────────────────
--
-- Linha ausente = detector desligado, e linha nova nasce desligada. Ligar é
-- ato explícito de alguém pela tela, registrado em `audit_event`. Um detector
-- de nota ligado por herança de default passaria a escrever no registro
-- acadêmico de minuto em minuto numa escola que não pediu.
--
-- ─── INTENÇÃO E OBSERVAÇÃO NA MESMA LINHA, EM COLUNAS SEPARADAS ─────────────
--
-- `ativo`, `intervalo_segundos` e a janela de horas são INTENÇÃO (a tela grava).
-- O resto é o que o worker OBSERVOU na última volta (só o worker grava). A tela
-- mostra os dois — "ligado" ao lado de "última sondagem há 40 min" é um
-- detector parado, e só se vê isso com as duas coisas juntas.
--
-- Requer PostgreSQL 13+.
-- ============================================================

CREATE TABLE IF NOT EXISTS fluxo_continuo (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,

    /* Chave do detector, do catálogo em packages/queues/src/continuo.ts. O
       catálogo diz o que ele sonda e que fluxo dispara; a tabela, nunca — pela
       mesma razão da 016: uma tabela que definisse fila e job transformaria a
       tela numa máquina de enfileirar job arbitrário. */
    chave        TEXT NOT NULL,

    -- ─── intenção (a tela grava) ──────────────────────────────────────────
    ativo              BOOLEAN NOT NULL DEFAULT false,
    intervalo_segundos INTEGER NOT NULL DEFAULT 60,
    /* Janela de horas em que o detector sonda, no fuso abaixo. Fim EXCLUSIVO;
       início = fim significa o dia inteiro; início > fim atravessa a meia-noite. */
    hora_inicio        SMALLINT NOT NULL DEFAULT 6,
    hora_fim           SMALLINT NOT NULL DEFAULT 22,
    timezone           TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    atualizado_por     UUID REFERENCES user_identity(id),

    -- ─── observação (só o worker grava) ───────────────────────────────────
    /* Marca d'água e memória de impressões da sondagem. Formato livre por
       detector; quem lê e escreve é só o próprio detector. */
    estado               JSONB NOT NULL DEFAULT '{}'::jsonb,
    ultima_sondagem_em   TIMESTAMPTZ,
    ultima_mudanca_em    TIMESTAMPTZ,
    /* O que a última mudança disparou: fluxo -> desfecho, mais o resumo do que
       foi visto. É o que a tela mostra como "13:42 → disparou Notas". */
    ultimo_disparo       JSONB,
    ultimo_disparo_em    TIMESTAMPTZ,
    ultimo_erro          TEXT,
    ultimo_erro_em       TIMESTAMPTZ,
    falhas_seguidas      INTEGER NOT NULL DEFAULT 0,
    /* Recusa de credencial do RM pausa o detector em vez de insistir: o RM
       bloqueia o usuário da integração depois de ~6 recusas (29/09/2026). */
    pausado_ate          TIMESTAMPTZ,
    /* Contagem do DIA (no fuso acima): sondagens, mudanças e disparos. Zera
       quando o dia vira. Basta para a pergunta "está trabalhando?" sem gravar
       uma linha por volta em lugar nenhum. */
    contadores           JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT fluxo_continuo_uq UNIQUE (tenant_id, chave),
    /* 30s é o piso: abaixo disso o detector de frequência, que lê uma página
       do /attendance por volta, passaria a pesar na cota do Toddle. Uma hora é
       o teto: acima disso a agenda comum já serve. */
    CONSTRAINT fluxo_continuo_intervalo_chk CHECK (intervalo_segundos BETWEEN 30 AND 3600),
    CONSTRAINT fluxo_continuo_horas_chk CHECK (hora_inicio BETWEEN 0 AND 23 AND hora_fim BETWEEN 0 AND 23),
    CONSTRAINT fluxo_continuo_falhas_chk CHECK (falhas_seguidas >= 0)
);
