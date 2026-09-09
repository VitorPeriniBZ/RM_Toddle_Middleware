-- =====================================================================
-- 014 — as três recusas da via de NOTA que são decisão de gente
--
-- ─── O PADRÃO QUE ESTA MIGRATION REPETE DE PROPÓSITO ─────────────────
--
-- A 012 abriu a fila para `OPCAO_SEM_POLITICA` com um argumento que vale
-- inteiro aqui: recusa de projeção que representa uma DECISÃO PENDENTE não é
-- defeito de dado, e morrer no stdout de um run significa que ninguém decide
-- nunca. A via de nota chega com três recusas desse tipo, e todas as três já
-- estão em `docs/DECISOES.md` como pendência de gente — sem dono no sistema.
--
-- ─── AS TRÊS ─────────────────────────────────────────────────────────
--
-- `JANELA_INCOMPATIVEL` — o de-para de etapa é por ORDINAL (T1 -> etapa 1) e as
-- janelas do Toddle divergem das do RM (D2). Em três faixas do ano o ordinal
-- aponta para a etapa errada; medido em 06/08/2026:
--
--     18/05 -> 22/06   está em T1, mas a etapa 1 do RM fechou em 15/05
--     09/09 -> 22/09   está em T2, mas a etapa 2 do RM fechou em 04/09
--     21/11 -> 11/12   nenhum T cobre
--
-- Quem resolve é o admin do Toddle, corrigindo as datas dos grading periods no
-- portal — e o ano corrente NÃO é editável, o que torna esta pendência de longo
-- prazo em vez de tarefa do dia. Enquanto ela existe, a nota daquela faixa não
-- chega ao RM, e isso precisa estar visível.
--
-- `VALOR_NAO_NUMERICO` — o RM guarda `NOTAFALTA` decimal (escala 0 a 7 nesta
-- escola) e as duas escalas cadastradas no Toddle são alfabéticas: medido em
-- 09/09/2026 via `GET /grade-scale`, as duas vêm com `valueType: "ALPHA"`
-- (EXEM/EXC/EXH/EVL/EMER/NA e A-E). A tabela de conceito do RM está VAZIA
-- (`COD_CONCEITO` nulo em 100% de 7.268 linhas), então não existe régua oficial
-- de letra para número. A conversão é decisão pedagógica da escola, e enfiá-la
-- num parser a esconderia de quem tem de tomá-la.
--
-- `ETAPA_NAO_LIBERADA` — `SETAPAS.DISPONIVELALUNOS='N'` em 100% das notas
-- medidas. Ninguém sabe se a flag é gerenciada nesta escola ou se nunca é
-- tocada. Sob a regra segura nada é publicável, porque publicar nota não
-- liberada mostra à família resultado provisório.
--
-- ─── UMA LINHA POR PERGUNTA, NÃO POR NOTA ────────────────────────────
--
-- Mesmo raciocínio da 012. `VALOR_NAO_NUMERICO` e `ETAPA_NAO_LIBERADA` fazem uma
-- pergunta só, que não muda de aluno para aluno, e por isso a `chave_natural`
-- delas é sintética:
--
--     ESCALA:<VALOR>            ex.: ESCALA:EXEM
--     ETAPA_TRAVADA:<CODETAPA>  ex.: ETAPA_TRAVADA:3
--
-- `JANELA_INCOMPATIVEL` é por (turma-disciplina, etapa), porque a sobreposição
-- de janelas é por etapa e a correção pode ser parcial:
--
--     JANELA:<IDTURMADISC>:<CODETAPA>
--
-- O `vezes_vista` da 010 passa a medir quantas notas cada pergunta está segurando
-- — que é a medida certa da urgência.
-- =====================================================================

-- Ver o comentário da 012 sobre o nome da constraint: derrubar o nome errado não
-- falha, apenas não faz nada, e o ADD seguinte criaria uma SEGUNDA regra ao lado
-- da primeira. Os dois nomes possíveis vão abaixo de propósito.
ALTER TABLE write_pendency DROP CONSTRAINT IF EXISTS wp_veredito_chk;
ALTER TABLE write_pendency DROP CONSTRAINT IF EXISTS write_pendency_veredito_check;

ALTER TABLE write_pendency
  ADD CONSTRAINT wp_veredito_chk
  CHECK (veredito IN (
    -- vereditos de decidirEscrita (migration 010)
    'CONFLITO_HUMANO',
    'EDITADO_POR_FORA',
    'REMOCAO_PEDE_HUMANO',
    -- recusa de projeção que é decisão de escola (migration 012)
    'OPCAO_SEM_POLITICA',
    -- o RM recusou a linha (migration 013)
    'RM_RECUSOU',
    -- as três da via de nota (esta migration)
    'JANELA_INCOMPATIVEL',
    'VALOR_NAO_NUMERICO',
    'ETAPA_NAO_LIBERADA'
  ));

COMMENT ON COLUMN write_pendency.chave_natural IS
  'Chave do que está pendente. Para vereditos de decisão é a chave natural do RM: '
  'frequência (CODCOLIGADA|IDHORARIOTURMA|IDTURMADISC|RA|DATA) e nota '
  '(CODCOLIGADA|CODETAPA|TIPOETAPA|IDTURMADISC|RA, a ordem do xs:unique do XSD). '
  'Para as recusas que fazem UMA pergunta é uma chave sintética: "OPCAO:<ABREV>", '
  '"ESCALA:<VALOR>", "ETAPA_TRAVADA:<CODETAPA>" e "JANELA:<IDTURMADISC>:<CODETAPA>" '
  '— uma linha por pergunta, não por registro.';
