-- Sessão de servidor: substitui o ID token do Google guardado em memória.
--
-- ─── O QUE ISTO CONSERTA ────────────────────────────────────────────────────
--
-- A "sessão" do painel ERA o ID token do Google. Duas consequências, e nenhuma
-- delas era um prazo que desse para aumentar:
--
--   1. o token expira em 1 HORA, prazo do Google;
--   2. ficando só em memória, qualquer recarregar de página o perdia.
--
-- E faltava o principal: não havia como DESLOGAR ninguém. Um token copiado
-- valia até expirar, e nada no sistema podia encurtar isso.
--
-- ─── POR QUE TOKEN OPACO NO BANCO, E NÃO JWT ────────────────────────────────
--
-- O middleware de autorização já vai ao banco a cada requisição para ler o
-- papel em `membership`. Com JWT pagaríamos o custo de uma sessão COM estado e
-- receberíamos as garantias de uma SEM estado — isto é, nenhuma. Com a linha
-- aqui, cortar um acesso é imediato.
--
-- Pela mesma razão não existe par "access curto + refresh": aquele padrão
-- existe para tornar tolerável um token que ninguém pode consultar.
--
-- ─── O COOKIE LEVA O SEGREDO; O BANCO GUARDA O HASH ─────────────────────────
--
-- 32 bytes aleatórios vão para o cookie. Aqui fica o sha256 deles, nunca o
-- valor: um dump desta tabela não entrega sessão nenhuma, porque o hash não
-- serve como cookie.

CREATE TABLE IF NOT EXISTS sessao (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,

  -- sha256 do valor do cookie, em hex. UNIQUE: é por ele que se procura.
  token_hash          char(64) NOT NULL UNIQUE,

  -- Identidade do Google (`sub`), a mesma chave usada em `membership`.
  subject             text NOT NULL,
  email               text,

  criada_em           timestamptz NOT NULL DEFAULT now(),
  vista_em            timestamptz NOT NULL DEFAULT now(),

  -- Desliza a cada uso, com throttle. Nunca passa de `expira_em`.
  ocioso_ate          timestamptz NOT NULL,
  -- Teto de vida. NÃO desliza: é o que garante que a sessão termina.
  expira_em           timestamptz NOT NULL,

  revogada_em         timestamptz,
  -- logout | revogar_outras | papel_alterado | admin | google_revogou
  revogada_por_que    text,

  ip                  text,
  user_agent          text
);

-- A busca por sessão ativa de um subject, e o "derrubar todas as dele".
CREATE INDEX IF NOT EXISTS sessao_subject_idx ON sessao (tenant_id, subject);
-- A limpeza periódica varre por aqui.
CREATE INDEX IF NOT EXISTS sessao_expira_idx ON sessao (expira_em);

COMMENT ON TABLE sessao IS
  'Sessão do plano de controle. Token opaco: o cookie leva 32 bytes aleatórios, aqui fica o sha256.';
COMMENT ON COLUMN sessao.ocioso_ate IS
  'Desliza a cada uso (com throttle), limitado por expira_em.';
COMMENT ON COLUMN sessao.expira_em IS
  'Teto absoluto. Nunca desliza — é o que garante que a sessão termina.';
COMMENT ON COLUMN sessao.revogada_por_que IS
  'Revogação é soft: a linha revogada é a prova de até quando aquele acesso funcionou.';
