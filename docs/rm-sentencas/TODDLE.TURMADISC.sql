-- ============================================================
-- Sentença RM: TODDLE.TURMADISC
-- Turma x Disciplina x Professor — fonte para sincronizar TURMAS e PROFESSORES
-- com o Toddle. Consumida pelo middleware via wsConsultaSQL.
--
-- CADASTRAR COM ESTE CÓDIGO EXATO: a chave que o web service usa é
-- coligada|sistema|código = 1|S|TODDLE.TURMADISC. O usuário do .env precisa ter
-- permissão nela. Testado em 2026-08-03: TURMA DISCIPLINA PROFESSOR,
-- TURMADISCIPLINAPROFESSOR, TODDLE.TURMADISC e TODDLETURMADISCV1 dão SOAP Fault
-- ("não existe ou não pôde ser executada por restrição de filtro").
--
-- Base: TODDLE.TURMADISC.V1.sql (JOINs conferidos na GLINKSREL do RM, mantidos).
-- Mudanças, e o porquê de cada uma:
--
--   + SEGMENTO / SERIE / TURNO / SECAO  derivadas de COD_TURMA. É o que resolve
--     o year group do Toddle. Ver bloco abaixo.
--   + AULAS_SEMANAIS  co-docência é a REGRA nesta escola (70 das 202
--     turma-disciplinas do campus 2 têm 2 ou 3 professores) e SPROFESSORTURMA
--     NÃO tem campo de titular. Nº de aulas semanais é o único critério
--     objetivo disponível para eleger um professor principal, se o Toddle exigir.
--   - NOME_CURSO, NIVEL_ENSINO, CHAPA, CODCURSO, NOME_DISC_REDUZIDO removidas:
--     medidas no export completo do campus 2, vêm vazias ou constantes em 100%
--     das linhas (NOME_CURSO vazia; NIVEL_ENSINO sempre "Ensino Básico"; CHAPA
--     vazia — sem vínculo com PFUNC; CODCURSO só MS/HS, mesma informação de
--     SEGMENTO). Se algum dia forem preenchidas, é só reincluir.
--
-- PARÂMETROS: apenas CODCOLIGADA e CODPERLET, iguais aos da Sentença de alunos.
-- NÃO fixar valores no lugar deles: a Sentença de alunos tinha CODCOLIGADA = 1 e
-- CODPERLET = '2026' hardcoded, e o efeito era o parâmetro ser silenciosamente
-- ignorado — passar 2025, 2026 ou nada devolvia o mesmo resultado.
--
-- NÃO filtrar por campus aqui: o middleware filtra por RM_CODFILIAL, e manter a
-- simetria com a Sentença de alunos evita que as duas divirjam de escopo.
-- ============================================================
SELECT
       -- --- identidade ---
       TD.IDTURMADISC                 AS ID_TURMADISC,   -- chave estável turma-disciplina
       TD.CODTURMA                    AS COD_TURMA,      -- casa com a Sentença de alunos
       T.NOME                         AS NOME_TURMA,     -- título da Class no Toddle
       TD.CODFILIAL                   AS CODFILIAL,      -- escopo de campus (2 = aeroporto)

       -- --- derivadas de COD_TURMA ---
       -- Formato verificado nas 35 turmas, 9 caracteres, sem exceção:
       --   EAV + segmento(2) + série(2) + turno(1) + seção(1)
       --   EAVHS10IA -> HS | 10 | I | A       EAVPS02MB -> PS | 02 | M | B
       -- ATENÇÃO: SERIE sozinha NÃO é única — PS01..PS05 (Infantil) colidem com
       -- ES01..ES05 (Fundamental I). A chave de série é SEGMENTO + SERIE.
       SUBSTRING(TD.CODTURMA, 4, 2)   AS SEGMENTO,       -- PS | ES | MS | HS
       SUBSTRING(TD.CODTURMA, 6, 2)   AS SERIE,          -- 01..12
       SUBSTRING(TD.CODTURMA, 8, 1)   AS TURNO,          -- I=Integral | M=Matutino
       SUBSTRING(TD.CODTURMA, 9, 1)   AS SECAO,          -- A | B | G

       -- --- disciplina ---
       TD.CODDISC                     AS CODDISC,
       D.NOME                         AS NOME_DISCIPLINA,

       -- --- professor ---
       -- CODPROF é a ÚNICA chave estável de professor: CHAPA vem vazia em 100%
       -- das linhas, então não há vínculo com a folha (PFUNC).
       PR.CODPROF                     AS CODPROF,
       PP.NOME                        AS NOME_PROFESSOR,
       -- O POST /staff do Toddle EXIGE e-mail, e o usa como identidade. Os dois
       -- campos vêm porque o institucional falta em parte do cadastro.
       PP.EMAIL                       AS EMAIL_PROFESSOR,
       PP.EMAILPESSOAL                AS EMAIL_PROF_PESSOAL,
       PT.AULASSEMANAISPROF           AS AULAS_SEMANAIS,

       -- --- flags: DEVOLVIDOS, não filtrados (ver nota no final) ---
       TD.ATIVA                       AS TURMADISC_ATIVA,
       PT.STATUS                      AS STATUS_PROF_TURMA,

       -- --- período letivo ---
       PL.CODPERLET                   AS CODPERLET,
       PL.DESCRICAO                   AS PERIODO_LETIVO
FROM   STURMADISC TD
JOIN   SPLETIVO PL ON PL.CODCOLIGADA = TD.CODCOLIGADA
                  AND PL.IDPERLET    = TD.IDPERLET
JOIN   STURMA   T  ON T.CODCOLIGADA  = TD.CODCOLIGADA
                  AND T.CODFILIAL    = TD.CODFILIAL
                  AND T.CODTURMA     = TD.CODTURMA
                  AND T.IDPERLET     = TD.IDPERLET
LEFT JOIN SDISCIPLINA D ON D.CODCOLIGADA = TD.CODCOLIGADA
                       AND D.CODDISC     = TD.CODDISC
-- LEFT JOIN nos três a seguir de propósito: turma-disciplina SEM professor
-- atribuído deve APARECER, com professor nulo, para o problema ficar visível.
-- Com INNER JOIN a linha desapareceria do roster silenciosamente.
LEFT JOIN SPROFESSORTURMA PT ON PT.CODCOLIGADA = TD.CODCOLIGADA
                            AND PT.IDTURMADISC = TD.IDTURMADISC
LEFT JOIN SPROFESSOR PR ON PR.CODCOLIGADA = PT.CODCOLIGADA
                       AND PR.CODPROF     = PT.CODPROF
LEFT JOIN PPESSOA PP ON PP.CODIGO = PR.CODPESSOA
WHERE  TD.CODCOLIGADA = :CODCOLIGADA
  AND  PL.CODPERLET   = :CODPERLET
-- Ordenação por CÓDIGO, não por nome: é determinística e não muda se a escola
-- renomear turma, disciplina ou professor.
ORDER BY TD.CODTURMA, TD.CODDISC, PR.CODPROF;

-- ============================================================
-- POR QUE NÃO HÁ FILTRO DE "ATIVO" AQUI
--
-- Não acrescente "AND TD.ATIVA = 'S'" nem "AND PT.STATUS = 1".
--
-- No export completo do campus 2 os dois campos vêm com um ÚNICO valor ('S' e
-- '1'), então o domínio é desconhecido: não se sabe que outros valores existem
-- nem o que significam. Filtrar agora é chute.
--
-- A lição vem da Sentença de alunos: lá, DEVOLVER o flag em vez de filtrar
-- revelou que "ativo" no RM cobre QUATRO códigos de status (Matriculado,
-- Matrícula em andamento, Aluno Visitante, Matrícula não enturmado). Uma lista
-- manual de códigos teria descartado 26 alunos em silêncio.
--
-- O middleware filtra, e o faz com o flag à vista no log.
-- ============================================================
