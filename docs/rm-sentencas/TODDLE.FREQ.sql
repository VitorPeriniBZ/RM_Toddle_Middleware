-- ============================================================
-- TODDLE.FREQ — frequência lançada no RM, por aula
--
-- Alimenta a via RM -> Toddle. NÃO serve para escrever no RM (isso é o
-- EduFrequenciaDiariaWSData via wsDataServer).
--
-- Cadastrada e VERIFICADA pelo web service em 05/08/2026: fevereiro/2026
-- devolveu 2.449 linhas, 19 colunas, PK única, sem fan-out.
-- O middleware a chama por RM_SENTENCA_FREQUENCIA=TODDLE.FREQ.
--
-- ─── ESTE ARQUIVO É A SENTENÇA CADASTRADA + 4 COLUNAS QUE FALTAM ────────────
--
-- A versão que está no RM é melhor que a minha proposta original em três pontos,
-- e estão preservados aqui:
--
--   1. `STURMADISC` entra por `F.IDTURMADISC`, não via SHORARIOTURMA. Assim uma
--      frequência cujo horário foi apagado não perde a turma.
--   2. `SHORARIOTURMA` é LEFT JOIN, pelo mesmo motivo.
--   3. `SHORARIO` entra por OUTER APPLY com TOP 1, ordenando pelo IDPERLET que
--      casa com a turma. Isso evita o fan-out que o meu INNER JOIN causaria
--      quando o mesmo CODHOR existe em mais de um período letivo. Verificado:
--      2.449 chaves para 2.449 linhas.
--
-- O ÚNICO ajuste real que falta são as 4 colunas abaixo, marcadas com (+):
-- CODCOLIGADA e as três de autoria. Ver §4 da ESPEC — sem CRIADO_POR não há
-- como autorizar remoção de falta sem aprovação humana caso a caso.
--
-- PARÂMETROS (4): CODCOLIGADA, CODPERLET, DATAINICIAL, DATAFINAL.
-- As datas no estilo 112, YYYYMMDD (ex.: 20260201). A janela é obrigatória e
-- isso é bom: 21.300 linhas no ano inteiro, nos dois campi.
-- ============================================================
SELECT F.CODCOLIGADA                  AS CODCOLIGADA,              -- (+) está na PK
       F.RA                           AS RA,
       F.IDTURMADISC                  AS ID_TURMADISC,
       F.DATA                         AS DATA,                     -- ISO nativo pelo WS
       F.IDHORARIOTURMA               AS ID_HORARIO_TURMA,

       -- MEDIDO: 'A' em 100% das linhas (21.300 no ano, 2.449 em fevereiro). O
       -- SFREQUENCIA guarda SÓ AUSÊNCIA — presença é a ausência de linha. É por
       -- isso que PRESENCA='P' na escrita REMOVE o registro.
       F.PRESENCA                     AS PRESENCA,

       -- MEDIDO: as 4 colunas abaixo vieram NULAS em todas as linhas — o DataSet
       -- do .NET omite coluna nula, então elas nem aparecem no XML. Nenhuma
       -- falta é justificada nesta escola (confirmar com a coordenação).
       F.JUSTIFICADA                  AS JUSTIFICADA,
       F.IDJUSTIFICATIVAFALTA         AS ID_JUSTIFICATIVA,
       J.DESCRICAO                    AS JUSTIFICATIVA_DESCRICAO,
       J.COMPOETOTALFALTAS            AS COMPOE_TOTAL_FALTAS,

       -- Resolução do período no Toddle.
       -- ATENÇÃO: o sufixo do CODHOR NÃO identifica a faixa de forma estável
       -- fora do campus 2. Ver §4.4 da ESPEC — no campus 1 a faixa 006 cobre
       -- TRÊS horários diferentes. Para o campus 2 é 1:1 e verificado.
       HT.CODHOR                      AS CODHOR,
       HT.CODHORARIOTURMA             AS CODHORARIOTURMA,
       SUBSTRING(CAST(HT.CODHOR AS VARCHAR(30)), 5, 3)  AS FAIXA_DE_CODHOR,
       H.AULA                         AS NUMERO_AULA,
       H.DIASEMANA                    AS DIASEMANA,                -- 1=domingo (RM)
       H.HORAINICIAL                  AS HORAINICIAL,
       H.HORAFINAL                    AS HORAFINAL,
       H.CODTURNO                     AS CODTURNO,

       -- Escopo, para o recorte fail-closed do middleware.
       TD.CODTURMA                    AS COD_TURMA,
       TD.CODDISC                     AS CODDISC,
       TD.CODFILIAL                   AS CODFILIAL,
       PL.CODPERLET                   AS CODPERLET,

       -- (+) AUTORIA — o que sustenta a política de remoção de falta.
       F.RECCREATEDBY                 AS CRIADO_POR,
       F.RECCREATEDON                 AS CRIADO_EM,
       F.RECMODIFIEDBY                AS ALTERADO_POR,
       F.RECMODIFIEDON                AS ALTERADO_EM   -- já vem com hora pelo WS

FROM   SFREQUENCIA F
JOIN   STURMADISC TD ON TD.CODCOLIGADA  = F.CODCOLIGADA
                    AND TD.IDTURMADISC  = F.IDTURMADISC
JOIN   SPLETIVO PL ON PL.CODCOLIGADA = TD.CODCOLIGADA
                  AND PL.IDPERLET    = TD.IDPERLET
LEFT JOIN SHORARIOTURMA HT ON HT.CODCOLIGADA    = F.CODCOLIGADA
                          AND HT.IDHORARIOTURMA = F.IDHORARIOTURMA
LEFT JOIN SJUSTIFICATIVAFALTA J ON J.CODCOLIGADA          = F.CODCOLIGADA
                               AND J.IDJUSTIFICATIVAFALTA = F.IDJUSTIFICATIVAFALTA
-- Dia e hora NÃO estão em SHORARIOTURMA: vivem em SHORARIO, por CODHOR. O TOP 1
-- ordenado pelo IDPERLET da turma é o que evita fan-out quando o CODHOR se
-- repete entre períodos letivos.
OUTER APPLY (
       SELECT TOP 1 S.DIASEMANA, S.HORAINICIAL, S.HORAFINAL, S.AULA, S.CODTURNO
       FROM   SHORARIO S
       WHERE  S.CODCOLIGADA = HT.CODCOLIGADA
         AND  S.CODHOR      = HT.CODHOR
       ORDER BY CASE WHEN S.IDPERLET = TD.IDPERLET THEN 0 ELSE 1 END, S.AULA
) H
WHERE  F.CODCOLIGADA = @CODCOLIGADA
  AND  PL.CODPERLET  = @CODPERLET
  AND  F.DATA       >= CONVERT(DATE, CAST(@DATAINICIAL AS VARCHAR(8)), 112)
  AND  F.DATA        < DATEADD(DAY, 1, CONVERT(DATE, CAST(@DATAFINAL AS VARCHAR(8)), 112))
ORDER BY F.DATA, TD.CODTURMA, TD.CODDISC, F.RA;

-- NÃO acrescente TOP nem LIMIT no SELECT externo. A Sentença de alunos nasceu
-- com `SELECT TOP 30` e truncou o roster silenciosamente — apareciam 2 turmas de
-- 185. (O TOP 1 do OUTER APPLY é outra coisa: é desambiguação de 1 registro.)
--
-- NÃO filtre por PRESENCA nem por campus. O primeiro esconde o que medimos; o
-- segundo é responsabilidade do middleware (RM_CODFILIAL, fail-closed).
