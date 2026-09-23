-- Parar de reescrever no Toddle o que não mudou.
--
-- ─── O QUE ISTO CONSERTA ────────────────────────────────────────────────────
--
-- O sync de alunos mandava PATCH para TODO aluno mapeado, em TODA passada. Não
-- havia comparação nenhuma: `updated` contava chamadas, não mudanças — e por
-- isso o painel mostrava sempre `updated: 50`, que é o tamanho do lote.
--
-- Medido em 23/09/2026 pelo `RECMODIFIEDON` do próprio RM: dos 866 alunos da
-- coligada, ZERO mudaram nas últimas 24h e 5 na última semana. No mesmo dia o
-- sync mandou 252 PATCH por rodada, 4 rodadas — ~1000 escritas para nenhuma
-- alteração.
--
-- ─── POR QUE HASH, E NÃO COMPARAR CAMPO A CAMPO CONTRA O TODDLE ─────────────
--
-- Comparar com o Toddle exigiria LER os 252 antes de escrever: trocaria PATCH
-- por GET e não economizaria chamada nenhuma, que é justamente o que aperta o
-- limitador de 2 req/s. O hash é do payload que ESTE middleware montou a partir
-- do RM — a pergunta que ele responde é "o que eu mandaria hoje é igual ao que
-- eu mandei da última vez?", e essa não precisa de rede.
--
-- ─── POR QUE TAMBÉM UM CARIMBO DE QUANDO FOI ESCRITO ────────────────────────
--
-- Pular escrita idêntica muda um efeito colateral que ninguém pediu mas que
-- existia: até aqui, qualquer edição feita à mão NO TODDLE era desfeita na
-- passada seguinte, porque o RM era reimposto todo dia. Com o pulo, essa edição
-- passaria a sobreviver para sempre — e a divergência entre os dois sistemas
-- deixaria de ter um limite.
--
-- `payload_escrito_em` dá esse limite: mesmo sem mudança, o registro é
-- reenviado quando passa de SYNC_REENVIO_DIAS (padrão 7). Continua cortando
-- ~96% das chamadas e mantém uma reconciliação semanal.
--
-- Colunas nulas no começo: o primeiro run depois do deploy não tem hash de
-- nada, escreve tudo uma vez e grava. Não há migração de dado a fazer.

ALTER TABLE id_mapping
  ADD COLUMN IF NOT EXISTS payload_hash        TEXT,
  ADD COLUMN IF NOT EXISTS payload_escrito_em  TIMESTAMPTZ;

COMMENT ON COLUMN id_mapping.payload_hash IS
  'sha256 do payload enviado ao destino na última escrita. Igual = nada a escrever.';
COMMENT ON COLUMN id_mapping.payload_escrito_em IS
  'Quando o payload foi de fato enviado. Limita por quanto tempo uma edição manual no destino sobrevive.';
