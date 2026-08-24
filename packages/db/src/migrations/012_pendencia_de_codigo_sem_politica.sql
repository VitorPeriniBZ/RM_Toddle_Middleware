-- =====================================================================
-- 012 — o código de chamada sem tradução também é pendência
--
-- ─── O QUE ESTAVA ERRADO ─────────────────────────────────────────────
--
-- `write_pendency` nasceu (migration 010) para receber os três vereditos de
-- `decidirEscrita` que exigem olho humano. Isso deixou de fora uma recusa que é
-- tão humana quanto as outras, e mais frequente: `OPCAO_SEM_POLITICA` — o Toddle
-- devolveu um código de chamada ("Leave", "Medical leave", "Half day") que não
-- tem par em `PRESENCA` no RM.
--
-- Medido em 24/08/2026, na primeira chamada real do piloto: 26 registros, 25
-- projetáveis, 1 recusado por "Leave". A recusa apareceu no relatório do run e
-- morreu ali. Relatório de run ninguém relê; fila com dono, sim. E enquanto
-- ninguém decide, aquele aluno simplesmente não tem frequência no RM — ausência
-- silenciosa, que é exatamente o que esta fila existe para não deixar acontecer.
--
-- ─── POR QUE UMA LINHA POR CÓDIGO, E NÃO POR REGISTRO ────────────────
--
-- A pergunta em aberto não é "o que fazer com a falta do Gabriel na segunda" —
-- é "o que 'Leave' significa nesta escola". Uma pendência por registro faria
-- centenas de linhas repetindo a MESMA pergunta, e a fila viraria ruído (o cron
-- roda 4x ao dia).
--
-- Por isso a `chave_natural` destas pendências é `OPCAO:<ABREVIACAO>` e não uma
-- chave de aula. O `vezes_vista` da 010 passa a contar quantas vezes o código
-- apareceu — que é a medida certa da urgência: um "Leave" solto é curiosidade,
-- 300 são um buraco na frequência da escola.
--
-- Consequência aceita: resolver a pendência é decidir a POLÍTICA (mexer em
-- `POLITICA_PRESENCA`), não lançar uma falta à mão. Está dito no `porque`.
-- =====================================================================

-- O nome da constraint é `wp_veredito_chk` — o que a migration 010 escreveu, não
-- o `write_pendency_veredito_check` que o Postgres geraria sozinho. Um
-- `DROP ... IF EXISTS` no nome errado não falha: ele não faz nada, e o ADD
-- seguinte cria uma SEGUNDA regra ao lado da primeira. As duas passam a valer, a
-- mais restritiva ganha, e o efeito é uma migration que roda limpa e não muda
-- nada. Foi exatamente o que aconteceu aqui antes desta correção.
ALTER TABLE write_pendency DROP CONSTRAINT IF EXISTS wp_veredito_chk;
ALTER TABLE write_pendency DROP CONSTRAINT IF EXISTS write_pendency_veredito_check;

ALTER TABLE write_pendency
  ADD CONSTRAINT wp_veredito_chk
  CHECK (veredito IN (
    -- vereditos de decidirEscrita (migration 010)
    'CONFLITO_HUMANO',
    'EDITADO_POR_FORA',
    'REMOCAO_PEDE_HUMANO',
    -- recusa de projeção que é decisão de escola, não defeito de dado
    'OPCAO_SEM_POLITICA'
  ));

COMMENT ON COLUMN write_pendency.chave_natural IS
  'Chave do que está pendente. Para vereditos de decisão é a chave natural do RM '
  '(CODCOLIGADA|IDHORARIOTURMA|IDTURMADISC|RA|DATA). Para OPCAO_SEM_POLITICA é '
  '"OPCAO:<ABREVIACAO>" — uma linha por código de chamada, não por registro, '
  'porque a pergunta é sobre o código e não sobre a aula.';
