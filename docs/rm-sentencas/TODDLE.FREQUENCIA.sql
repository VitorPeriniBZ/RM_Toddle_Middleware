-- ============================================================
-- TODDLE.FREQUENCIA — frequência lançada no RM, por aula
--
-- Alimenta a via RM -> Toddle: espelha no LMS a falta que a escola já lançou no
-- TOTVS (14.632 registros medidos em 05/08/2026). NÃO serve para escrever no RM.
--
-- Cadastrar na tela de Consultas SQL do RM com o código EXATO
-- `TODDLE.FREQUENCIA`, e garantir permissão ao usuário do .env. A chave é
-- coligada|sistema|código = 1|S|TODDLE.FREQUENCIA.
--
-- PARÂMETROS: CODCOLIGADA e CODPERLET, iguais aos das outras Sentenças.
-- NÃO filtrar por campus aqui: o middleware filtra por RM_CODFILIAL, e manter a
-- coluna no resultado deixa o recorte auditável.
--
-- Nomes de coluna conferidos no dicionário (SFREQUENCIA tem 12 colunas; dia e
-- hora NÃO estão em SHORARIOTURMA, e sim em SHORARIO, ligada por CODHOR).
-- ============================================================
SELECT F.CODCOLIGADA                     AS CODCOLIGADA,
       F.RA                              AS RA,               -- -> studentId (id_mapping STUDENT)
       F.IDTURMADISC                     AS IDTURMADISC,      -- -> courseId  (id_mapping COURSE)
       F.DATA                            AS DATA,             -- data da aula
       F.IDHORARIOTURMA                  AS IDHORARIOTURMA,   -- chave da aula no RM

       -- O que aconteceu. PRESENCA é o campo cujo DOMÍNIO REAL nunca conseguimos
       -- medir: o ReadView do DataServer de frequência usa filtro posicional que
       -- não deciframos, e 'A'/'P' vem do PDF da TOTVS. Esta Sentença resolve
       -- isso — o primeiro retorno dela é a medição.
       F.PRESENCA                        AS PRESENCA,
       F.JUSTIFICADA                     AS JUSTIFICADA,      -- falta abonada
       F.IDJUSTIFICATIVAFALTA            AS IDJUSTIFICATIVAFALTA,
       J.DESCRICAO                       AS JUSTIFICATIVA,
       J.COMPOETOTALFALTAS               AS JUSTIF_COMPOE_TOTAL,

       -- Dia e faixa: é o que resolve o periodId do Toddle. O sufixo do CODHOR
       -- (posições 5-7) mapeia 1:1 para a faixa de horário — verificado nos 518
       -- horários do campus 2.
       H.DIASEMANA                       AS DIASEMANA,        -- 1=domingo no RM
       H.HORAINICIAL                     AS HORAINICIAL,
       H.HORAFINAL                       AS HORAFINAL,
       HT.CODHOR                         AS CODHOR,
       SUBSTRING(HT.CODHOR, 5, 3)        AS FAIXA,            -- -> id_mapping PERIOD

       -- Contexto de escopo, para o filtro fail-closed do middleware.
       HT.CODFILIAL                      AS CODFILIAL,
       HT.IDPERLET                       AS IDPERLET,
       PL.CODPERLET                      AS CODPERLET,
       TD.CODTURMA                       AS CODTURMA,
       TD.CODDISC                        AS CODDISC,

       -- AUDITORIA — não é enfeite. O conselho técnico (05/08/2026) foi explícito:
       -- sem saber QUEM criou o registro, não há como distinguir eco da própria
       -- integração de alteração humana, e não há como autorizar remoção de falta.
       -- RECCREATEDBY diz se a linha nasceu do usuário de integração ou de uma
       -- pessoa; RECMODIFIEDON é a marca d'água do sync incremental.
       F.RECCREATEDBY                    AS RECCREATEDBY,
       F.RECCREATEDON                    AS RECCREATEDON,
       F.RECMODIFIEDBY                   AS RECMODIFIEDBY,
       F.RECMODIFIEDON                   AS RECMODIFIEDON

FROM   SFREQUENCIA F
       INNER JOIN SHORARIOTURMA HT ON HT.CODCOLIGADA    = F.CODCOLIGADA
                                  AND HT.IDHORARIOTURMA = F.IDHORARIOTURMA
       INNER JOIN SHORARIO H       ON H.CODCOLIGADA     = HT.CODCOLIGADA
                                  AND H.CODHOR          = HT.CODHOR
       INNER JOIN STURMADISC TD    ON TD.CODCOLIGADA    = HT.CODCOLIGADA
                                  AND TD.IDTURMADISC    = HT.IDTURMADISC
       INNER JOIN SPLETIVO PL      ON PL.CODCOLIGADA    = HT.CODCOLIGADA
                                  AND PL.IDPERLET       = HT.IDPERLET
       LEFT  JOIN SJUSTIFICATIVAFALTA J ON J.CODCOLIGADA          = F.CODCOLIGADA
                                       AND J.IDJUSTIFICATIVAFALTA = F.IDJUSTIFICATIVAFALTA
WHERE  F.CODCOLIGADA = :CODCOLIGADA
  AND  PL.CODPERLET  = :CODPERLET
ORDER BY F.IDTURMADISC, F.DATA, F.RA;

-- NÃO acrescente TOP nem LIMIT. A Sentença de alunos nasceu com `SELECT TOP 30`
-- e truncou o roster silenciosamente por dias — só apareciam duas turmas.
--
-- NÃO filtre por PRESENCA. Precisamos ver o domínio inteiro; filtrar esconde
-- justamente o que queremos medir.
--
-- NÃO filtre por campus: o recorte é do middleware (RM_CODFILIAL), e a coluna
-- CODFILIAL no resultado é o que torna esse recorte auditável.
