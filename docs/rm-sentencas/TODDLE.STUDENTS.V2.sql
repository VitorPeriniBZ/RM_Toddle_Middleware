SELECT
       A.RA                        AS RA,
       P.NOME                      AS NOME_COMPLETO,
       A.CODPESSOA                 AS CODINTERNO,
       M.CODFILIAL                 AS CODFILIAL,
       M.CODTURMA                  AS COD_TURMA,
       T.NOME                      AS NOME_TURMA,
       M.PERIODO                   AS PERIODO_SERIE,
       TC.NOME                     AS NIVEL_ENSINO,
       PL.CODPERLET                AS CODPERLET,
       PL.DESCRICAO                AS PERIODO_LETIVO,
       P.EMAIL                     AS EMAIL,
       P.EMAILPESSOAL              AS EMAIL_PESSOAL,
       P.DTNASCIMENTO              AS DTNASCIMENTO,
       P.SEXO                      AS SEXO,
       M.CODSTATUS                 AS STATUS_MATRICULA,
       ST.DESCRICAO                AS STATUS_DESCRICAO,
       ST.PLATIVO                  AS STATUS_ATIVO
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
LEFT JOIN SSTATUS ST ON ST.CODCOLIGADA = M.CODCOLIGADA
                    AND ST.CODSTATUS   = M.CODSTATUS
LEFT JOIN STIPOCURSO TC ON TC.CODCOLIGADA  = T.CODCOLIGADA
                       AND TC.CODTIPOCURSO = T.CODTIPOCURSO
WHERE  A.CODCOLIGADA = :CODCOLIGADA
  AND  PL.CODPERLET  = :CODPERLET
ORDER BY T.NOME, P.NOME
