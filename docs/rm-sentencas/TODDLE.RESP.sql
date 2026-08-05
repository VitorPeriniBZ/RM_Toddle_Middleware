-- ============================================================
-- TODDLE.RESP — responsáveis dos alunos, para o POST /public/v2/parents
--
-- POR QUE UMA SENTENÇA NOVA
--
-- A Sentença de alunos (TODDLE.STUDENTS) devolve 18 colunas e NENHUMA de
-- responsável — conferido em 05/08/2026.
--
-- E não há DataServer para o vínculo acadêmico: `EduAlunoResponsavelData`,
-- `EduAlunoRespData` e `SalunoResponsavelData` não existem. O que existe,
-- `EduResponsavelData`, é a tabela `SResponsavel` = "Responsáveis pela PARCELA DO
-- CONTRATO", ou seja o financeiro do contrato, não o responsável do aluno.
--
-- Nomes de coluna conferidos no dicionário. `SALUNORESPONSAVEL` tem 11 colunas e
-- guarda só o VÍNCULO; nome e e-mail vêm de `PPESSOA`.
--
-- PARÂMETROS: CODCOLIGADA e CODPERLET, como as outras. O recorte de campus é do
-- middleware (RM_CODFILIAL) — a coluna vem no resultado para ser auditável.
-- ============================================================
SELECT R.CODCOLIGADA                     AS CODCOLIGADA,
       R.RA                              AS RA,               -- -> children[] (via id_mapping STUDENT)
       R.CODPESSOA                       AS COD_PESSOA,       -- -> chave do PARENT no id_mapping
       P.NOME                            AS NOME_COMPLETO,    -- -> firstName + lastName (split no middleware)

       -- O GARGALO: o POST /parents exige email. Sem ele, o responsável não
       -- existe no Toddle. Institucional tem precedência; pessoal é fallback.
       P.EMAIL                           AS EMAIL,
       P.EMAILPESSOAL                    AS EMAIL_PESSOAL,

       P.SEXO                            AS SEXO,             -- -> gender (opcional)
       P.TELEFONE1                       AS TELEFONE1,        -- não vai para o Toddle; ajuda a secretaria
       P.TELEFONE2                       AS TELEFONE2,

       -- Tipo e parentesco: viram `relationships[].relationship`.
       R.CODTIPORESP                     AS COD_TIPO_RESP,
       TR.DESCRICAO                      AS TIPO_RESP,        -- ex.: academico / financeiro
       R.CODPARENTESCO                    AS COD_PARENTESCO,
       PA.DESCRICAO                      AS PARENTESCO,       -- ex.: Mãe, Pai, Avó

       -- STATUS do vínculo: só responsável ATIVO deve virar parent. O domínio
       -- ainda NÃO foi medido — o primeiro retorno resolve.
       R.STATUS                          AS STATUS_VINCULO,

       -- Escopo, vindo do aluno.
       A.CODFILIAL                       AS CODFILIAL,

       -- Auditoria, mesmo padrão da Sentença de frequência: marca d'água para
       -- sync incremental e distinção humano/integração.
       R.RECCREATEDBY                    AS CRIADO_POR,
       R.RECCREATEDON                    AS CRIADO_EM,
       R.RECMODIFIEDBY                   AS ALTERADO_POR,
       R.RECMODIFIEDON                   AS ALTERADO_EM

FROM   SALUNORESPONSAVEL R
       INNER JOIN PPESSOA P ON P.CODIGO = R.CODPESSOA
       INNER JOIN SALUNO A  ON A.CODCOLIGADA = R.CODCOLIGADA
                           AND A.RA          = R.RA
       -- LEFT nos dois: vínculo sem tipo ou sem parentesco cadastrado não deve
       -- desaparecer do resultado. Foi o que quase aconteceu com a justificativa
       -- de falta, onde um INNER teria zerado 21.300 linhas.
       LEFT  JOIN STIPORESPONSAVEL TR ON TR.CODCOLIGADA = R.CODCOLIGADA
                                     AND TR.CODTIPORESP = R.CODTIPORESP
       LEFT  JOIN PCODPARENT PA       ON PA.CODCLIENTE  = R.CODPARENTESCO
       -- Só alunos com matrícula no período letivo pedido, para o volume não
       -- virar o histórico inteiro da escola.
       INNER JOIN SMATRICPL M ON M.CODCOLIGADA = A.CODCOLIGADA
                             AND M.RA          = A.RA
       INNER JOIN SPLETIVO PL ON PL.CODCOLIGADA = M.CODCOLIGADA
                             AND PL.IDPERLET    = M.IDPERLET
WHERE  R.CODCOLIGADA = :CODCOLIGADA
  AND  PL.CODPERLET  = :CODPERLET
GROUP BY R.CODCOLIGADA, R.RA, R.CODPESSOA, P.NOME, P.EMAIL, P.EMAILPESSOAL,
         P.SEXO, P.TELEFONE1, P.TELEFONE2, R.CODTIPORESP, TR.DESCRICAO,
         R.CODPARENTESCO, PA.DESCRICAO, R.STATUS, A.CODFILIAL,
         R.RECCREATEDBY, R.RECCREATEDON, R.RECMODIFIEDBY, R.RECMODIFIEDON
ORDER BY R.RA, R.CODPESSOA;

-- O GROUP BY existe porque SMATRICPL pode ter mais de uma linha por aluno
-- (troca de turma gera matrícula nova — medido: 6 alunos com linha ativa E
-- inativa). Sem ele, cada responsável sairia duplicado por matrícula.
--
-- NÃO acrescente TOP nem LIMIT: a Sentença de alunos nasceu com `SELECT TOP 30`
-- e truncou o roster silenciosamente por dias.
--
-- NÃO filtre por STATUS ainda: o domínio não foi medido, e filtrar antes de saber
-- esconde o que precisamos ver.
