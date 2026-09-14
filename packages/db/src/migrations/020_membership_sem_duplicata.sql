-- ============================================================
-- `membership` passa a recusar o mesmo papel duas vezes.
--
-- ─── O DEFEITO ──────────────────────────────────────────────────────────────
--
-- A migration 006 criou:
--
--   CONSTRAINT membership_uq UNIQUE (user_identity_id, tenant_id, campus_id, papel)
--
-- e `campus_id` é NULL em toda linha, porque NULL significa "todos os campi" e a
-- escola em escopo tem um só. Em Postgres, NULL não participa de UNIQUE: duas
-- linhas com `campus_id IS NULL` e todo o resto igual são as duas aceitas.
--
-- Consequência: o `ON CONFLICT ... DO NOTHING` de `concederPapel` nunca
-- conflitava. `npm run conceder` rodado duas vezes criava DUAS linhas do mesmo
-- papel, e a função reportava `jaTinha: false` nas duas — dizendo que concedeu
-- algo que já existia.
--
-- Não tinha mordido porque só houve uma concessão em produção. A tela de acessos
-- é que torna o clique duplo trivial: dois cliques no botão "Conceder" são dois
-- INSERTs, e revogar depois apagaria os dois de uma vez (o DELETE não tem
-- LIMIT) — o que por acaso conserta, mas por acidente.
--
-- É o mesmo NULL-em-UNIQUE que `id_mapping` já tinha encontrado e resolvido com
-- índice sobre `coalesce(campo, '')`. Aqui o índice PARCIAL diz a mesma coisa de
-- forma mais direta, porque o caso NULL é o único que existe hoje.
--
-- ─── A DEDUPLICAÇÃO VEM ANTES, E TEM DE VIR ─────────────────────────────────
--
-- Criar o índice numa tabela que já tenha duplicata falha, e a migration inteira
-- volta. Manter a linha MAIS ANTIGA preserva `created_at` como "desde quando
-- esta pessoa tem este papel" — que é a pergunta que alguém faz olhando a
-- trilha.
-- ============================================================

DELETE FROM membership m
 USING membership outra
 WHERE m.user_identity_id = outra.user_identity_id
   AND m.tenant_id        = outra.tenant_id
   AND m.papel            = outra.papel
   AND m.campus_id IS NULL
   AND outra.campus_id IS NULL
   AND (m.created_at, m.id) > (outra.created_at, outra.id);

-- O `membership_uq` de 006 CONTINUA, e cobre o caso com campus. Este cobre o
-- caso NULL, que é o que ele deixa passar.
CREATE UNIQUE INDEX IF NOT EXISTS membership_sem_campus_uq
    ON membership (user_identity_id, tenant_id, papel)
 WHERE campus_id IS NULL;

COMMENT ON INDEX membership_sem_campus_uq IS
  'NULL nao participa de UNIQUE: sem este indice parcial, membership_uq deixa o mesmo papel entrar duas vezes quando campus_id e NULL, que e o caso de 100% das linhas hoje.';
