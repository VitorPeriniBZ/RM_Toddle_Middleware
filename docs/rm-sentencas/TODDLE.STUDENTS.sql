-- =====================================================================
-- Sentença RM: TODDLE.STUDENTS   (roster de alunos p/ o Fluxo 1)
-- Consumida por src/services/rmStudentSource.ts via wsConsultaSQL.
--
-- Nomes de tabela/coluna CONFERIDOS no dicionário de dados do RM
-- (skill totvs-rm, 8.521 tabelas / 127.357 colunas) — não são chute.
-- Os JOINs vieram da GLINKSREL, ou seja, são os relacionamentos reais.
--
-- Correções sobre a versão em produção em 2026-07-31:
--   1. REMOVIDO o "TOP 30" — truncava o roster (30 alunos, 2 turmas; a turma
--      EAVHS10IB vinha cortada no 7º aluno por causa do ORDER BY).
--   2. CODCOLIGADA e CODPERLET agora vêm dos PARÂMETROS, não hardcoded.
--      Com valores fixos, a virada de ano letivo exige editar a Sentença.
--   3. ADICIONADAS as colunas de enriquecimento (EMAIL/DTNASCIMENTO/SEXO)
--      e a chave interna (CODINTERNO), que o middleware lê como opcionais.
--   4. Matrícula ativa: em vez de adivinhar qual CODSTATUS é "ativo", o JOIN
--      com SSTATUS expõe DESCRICAO e o flag PLATIVO ("Indica se está ativo
--      no P. Letivo"). Rode UMA vez com as colunas de diagnóstico e depois
--      descomente o filtro (ver bloco no final).
--   5. ADICIONADA a coluna CODFILIAL. Ela NÃO é decorativa: o middleware
--      filtra o escopo de campus por ela (RM_CODFILIAL no .env). Sem a coluna
--      no SELECT, com RM_CODFILIAL=2 o extract descartava as 586 linhas como
--      "fora do escopo" e o sync rodava com 0 aluno.
--
-- Verificado no XML cru em 2026-07-31: RA, NOME, COD_TURMA, NOME_TURMA,
-- STATUS_MATRICULA, CODPERLET e PERIODO_LETIVO vêm preenchidas nas 30 linhas.
-- CORREÇÃO 2026-07-31 (retorno completo): PERIODO_SERIE (M.PERIODO) NÃO vem
-- NULL em todas — vem preenchido SÓ nas matrículas CANCELADAS (CODSTATUS 17).
-- Nas ativas vem vazio. Usar como fallback de série daria valor apenas para
-- aluno inativo. O DataSet do .NET omite a
-- coluna quando o valor é nulo — coluna ausente no XML = valor nulo, não
-- "Sentença sem a coluna". Enquanto M.PERIODO não for populado no RM, a série
-- NÃO serve como chave de year group; use COD_TURMA ou NOME_TURMA.
--
-- Os APELIDOS das colunas importam: pick() em rmStudentSource.ts casa por
-- nome (case-insensitive). Não renomear sem ajustar o código.
-- =====================================================================
SELECT
       A.RA                        AS RA,              -- obrigatória -> sourceId
       P.NOME                      AS NOME_COMPLETO,   -- obrigatória -> firstName/lastName
       A.CODPESSOA                 AS CODINTERNO,      -- chave interna estável (informativa)
       M.CODFILIAL                 AS CODFILIAL,       -- OBRIGATÓRIA: rmStudentSource filtra por RM_CODFILIAL
       M.CODTURMA                  AS COD_TURMA,       -- chave atual de year group
       T.NOME                      AS NOME_TURMA,      -- ex.: '10th grade A - 1ª série'
       M.PERIODO                   AS PERIODO_SERIE,   -- ATENÇÃO: vem NULL nesta base (ver cabeçalho)
       TC.NOME                     AS NIVEL_ENSINO,    -- Infantil/Fundamental/Médio — ajuda no de-para
       PL.CODPERLET                AS CODPERLET,
       PL.DESCRICAO                AS PERIODO_LETIVO,
       -- --- enriquecimento (opcionais no middleware) ---
       P.EMAIL                     AS EMAIL,           -- institucional (precedência)
       P.EMAILPESSOAL              AS EMAIL_PESSOAL,   -- fallback
       P.DTNASCIMENTO              AS DTNASCIMENTO,    -- o middleware normaliza p/ YYYY-MM-DD
       P.SEXO                      AS SEXO,            -- 'M' / 'F'
       -- --- diagnóstico do status (remover depois de definir o filtro) ---
       M.CODSTATUS                 AS STATUS_MATRICULA,
       ST.DESCRICAO                AS STATUS_DESCRICAO,
       ST.PLATIVO                  AS STATUS_ATIVO     -- flag do RM: ativo no P. Letivo
FROM   SALUNO   A
JOIN   PPESSOA  P  ON P.CODIGO       = A.CODPESSOA
JOIN   SMATRICPL M ON M.CODCOLIGADA  = A.CODCOLIGADA
                  AND M.RA           = A.RA
JOIN   SPLETIVO PL ON PL.CODCOLIGADA = M.CODCOLIGADA
                  AND PL.IDPERLET    = M.IDPERLET
JOIN   STURMA   T  ON T.CODCOLIGADA  = M.CODCOLIGADA
                  AND T.CODFILIAL    = M.CODFILIAL
                  AND T.CODTURMA     = M.CODTURMA
                  AND T.IDPERLET     = M.IDPERLET
-- SSTATUS: "Status de Matrícula". JOIN conforme GLINKSREL.
LEFT JOIN SSTATUS ST ON ST.CODCOLIGADA = M.CODCOLIGADA
                    AND ST.CODSTATUS   = M.CODSTATUS
-- Nível de ensino da turma (STIPOCURSO = "Nível de Ensino").
LEFT JOIN STIPOCURSO TC ON TC.CODCOLIGADA  = T.CODCOLIGADA
                       AND TC.CODTIPOCURSO = T.CODTIPOCURSO
WHERE  A.CODCOLIGADA = :CODCOLIGADA
  AND  PL.CODPERLET  = :CODPERLET
-- ESCOPO POR CAMPUS: só o campus do aeroporto (CODFILIAL=2, Fundamental II +
-- Médio) entra no Toddle. O CODFILIAL=1 (Infantil + Fundamental I) fica fora.
--
-- O filtro é feito NO MIDDLEWARE (RM_CODFILIAL no .env), e por isso a coluna
-- CODFILIAL é OBRIGATÓRIA no SELECT acima: rmStudentSource.ts faz
-- pick(row,'CODFILIAL') e descarta toda linha sem esse valor quando
-- RM_CODFILIAL está preenchido. Sem a coluna, o roster inteiro cai como
-- "fora do escopo" (586 -> 0 alunos, com foraDoEscopo=586 no log).
--
-- Filtrar TAMBÉM aqui é opcional e só economiza tráfego (586 -> 295). Se
-- descomentar, declare CODFILIAL como parâmetro da Sentença — e mantenha a
-- coluna no SELECT de qualquer forma.
--  AND  M.CODFILIAL = :CODFILIAL
-- FILTRO DE MATRÍCULA ATIVA — descomentar depois de conferir, na 1ª execução,
-- como PLATIVO se materializa nesta base (o dicionário do RM não traz tipos:
-- pode ser 1/0 ou 'T'/'F'). Alternativa: deixar sem filtro no SQL e preencher
-- RM_ACTIVE_TERM_STATUSES no .env, que filtra pelo mesmo CODSTATUS.
--  AND  ST.PLATIVO = 1
ORDER BY T.NOME, P.NOME;
