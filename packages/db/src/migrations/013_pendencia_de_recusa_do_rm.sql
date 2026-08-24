-- =====================================================================
-- 013 — a linha que o RM recusa também precisa de dono
--
-- ─── O QUE ACONTECEU ─────────────────────────────────────────────────
--
-- Primeira escrita real do piloto, 24/08/2026: 25 linhas de uma aula de
-- Geografia (IDTURMADISC 1266). O RM recusou o dataset inteiro com
--
--     Violação de chave estrangeira
--     - inclusão de registro detalhe sem um registro mestre associado
--
-- Bissecando linha a linha, UMA aluna (RA 202500101) falhava sozinha; as outras
-- 24 passavam. Ela está matriculada na TURMA (EAVHS11IA, status "Matriculado",
-- ativa) — mas isso não é a mesma coisa que estar matriculada na TURMA-DISCIPLINA
-- 1266. A `SFREQUENCIA` é detalhe do vínculo aluno×turma-disciplina, e esse
-- vínculo não existe para ela.
--
-- ─── POR QUE ISSO É ESTRUTURAL, E NÃO UM CASO ISOLADO ────────────────
--
-- A turma do Toddle e a turma-disciplina do RM são listas DIFERENTES que se
-- parecem. O Toddle tinha 26 alunos na classe de Geografia; o RM tem 32 na turma
-- EAVHS11IA; e a interseção com quem realmente cursa Geografia é uma terceira
-- lista. Optativa, dispensa, matrícula em andamento — qualquer uma produz
-- divergência, e nenhuma é erro de ninguém.
--
-- Nós NÃO conseguimos detectar isso antes de tentar: não há Sentença de
-- matrícula por turma-disciplina registrada no RM (a TODDLE.STUDENTS devolve
-- CODTURMA, não IDTURMADISC). Enquanto não houver, o RM é a única autoridade, e
-- a resposta dele só vem depois do `SaveRecord`.
--
-- Daí o veredito: `RM_RECUSOU` é a recusa que só existe DEPOIS da tentativa. Ele
-- carrega a mensagem do RM no `porque`, porque é a única explicação que existe.
--
-- ─── O QUE MUDA NO COMPORTAMENTO ─────────────────────────────────────
--
-- O writer deixou de tratar recusa de dataset como perda do lote. Ele parte o
-- lote ao meio e reenvia, recursivamente, até isolar a(s) linha(s) que o RM não
-- aceita. As demais são escritas. Uma aluna sem vínculo não pode custar a
-- frequência da turma inteira.
-- =====================================================================

ALTER TABLE write_pendency DROP CONSTRAINT IF EXISTS wp_veredito_chk;

ALTER TABLE write_pendency
  ADD CONSTRAINT wp_veredito_chk
  CHECK (veredito IN (
    -- vereditos de decidirEscrita (migration 010)
    'CONFLITO_HUMANO',
    'EDITADO_POR_FORA',
    'REMOCAO_PEDE_HUMANO',
    -- recusa de projeção que é decisão de escola (migration 012)
    'OPCAO_SEM_POLITICA',
    -- o RM recusou esta linha específica; só se descobre tentando (013)
    'RM_RECUSOU'
  ));
