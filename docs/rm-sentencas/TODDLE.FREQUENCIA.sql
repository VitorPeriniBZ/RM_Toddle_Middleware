-- ============================================================
-- TODDLE.FREQUENCIA — frequência lançada no RM, por aula
--
-- Alimenta a via RM -> Toddle: espelha no LMS a falta que a escola já lançou no
-- TOTVS. NÃO serve para escrever no RM (isso é o EduFrequenciaDiariaWSData).
--
-- Cadastrar na tela de Consultas SQL com o código EXATO `TODDLE.FREQUENCIA`, e
-- dar permissão ao usuário do .env. Chave: coligada|sistema|código =
-- 1|S|TODDLE.FREQUENCIA. O middleware a chama por RM_SENTENCA_FREQUENCIA.
--
-- ─── VERSÃO 2, ajustada com o retorno real de 05/08/2026 (21.300 linhas) ────
--
-- Os nomes de coluna seguem o que a V1 cadastrada devolveu (com underscore), para
-- o recadastro ser um diff pequeno. O que MUDOU em relação ao que está no RM:
--
--   + CODCOLIGADA          faltava, e faz parte da PK do SFREQUENCIA
--   + CRIADO_POR/EM        RECCREATEDBY/ON — sem isso não há como distinguir
--                          falta lançada por humano de falta criada pela
--                          integração, e portanto não há como autorizar remoção
--   + ALTERADO_POR         RECMODIFIEDBY
--   ~ DATA                 agora ISO (era dd/MM/yyyy)
--   ~ ALTERADO_EM          agora com HORA (era só data — marca d'água de dia
--                          inteiro forçaria reprocessar o dia todo)
--   - FAIXA_DE_CODHORARIOTURMA  saiu: devolvia "220", extraído da string
--                          composta do CODHORARIOTURMA. Não servia para nada.
--
-- PARÂMETROS: CODCOLIGADA e CODPERLET. NÃO filtre campus aqui — o middleware
-- filtra por RM_CODFILIAL, e a coluna no resultado torna o recorte auditável.
-- ============================================================
SELECT F.CODCOLIGADA                          AS CODCOLIGADA,
       F.RA                                   AS RA,                -- -> studentId
       F.IDTURMADISC                          AS ID_TURMADISC,      -- -> courseId
       CONVERT(varchar(10), F.DATA, 23)       AS DATA,              -- ISO YYYY-MM-DD
       F.IDHORARIOTURMA                       AS ID_HORARIO_TURMA,

       -- MEDIDO em 05/08/2026: 'A' em 21.300 de 21.300 linhas. O SFREQUENCIA
       -- guarda SÓ AUSÊNCIA — presença é a ausência de linha. É por isso que
       -- PRESENCA='P' na escrita REMOVE o registro em vez de "marcar presente".
       F.PRESENCA                             AS PRESENCA,
       F.JUSTIFICADA                          AS JUSTIFICADA,
       F.IDJUSTIFICATIVAFALTA                 AS ID_JUSTIFICATIVA,
       J.DESCRICAO                            AS JUSTIFICATIVA_DESCRICAO,
       J.COMPOETOTALFALTAS                    AS COMPOE_TOTAL_FALTAS,

       -- Dia e faixa resolvem o periodId do Toddle. O sufixo do CODHOR é a
       -- faixa; ATENÇÃO: ele NÃO é global — a faixa 001 é 08:00-08:20 no campus
       -- 2 e 08:00-08:50 no campus 1. Sempre resolver junto com CODFILIAL.
       HT.CODHOR                              AS CODHOR,
       HT.CODHORARIOTURMA                     AS CODHORARIOTURMA,
       SUBSTRING(HT.CODHOR, 5, 3)             AS FAIXA_DE_CODHOR,   -- 001..013
       H.AULA                                 AS NUMERO_AULA,
       H.DIASEMANA                            AS DIASEMANA,         -- 1=domingo (RM)
       H.HORAINICIAL                          AS HORAINICIAL,
       H.HORAFINAL                            AS HORAFINAL,
       H.CODTURNO                             AS CODTURNO,

       -- Escopo, para o filtro fail-closed do middleware.
       TD.CODTURMA                            AS COD_TURMA,
       TD.CODDISC                             AS CODDISC,
       HT.CODFILIAL                           AS CODFILIAL,
       PL.CODPERLET                           AS CODPERLET,

       -- AUDITORIA — não é enfeite, é o que sustenta a política de remoção de
       -- falta e a marca d'água do sync incremental. Ver §4 da ESPEC.
       F.RECCREATEDBY                         AS CRIADO_POR,
       CONVERT(varchar(19), F.RECCREATEDON, 120)   AS CRIADO_EM,
       F.RECMODIFIEDBY                        AS ALTERADO_POR,
       CONVERT(varchar(19), F.RECMODIFIEDON, 120)  AS ALTERADO_EM

FROM   SFREQUENCIA F
       INNER JOIN SHORARIOTURMA HT ON HT.CODCOLIGADA    = F.CODCOLIGADA
                                  AND HT.IDHORARIOTURMA = F.IDHORARIOTURMA
       -- Dia e hora NÃO estão em SHORARIOTURMA: vivem em SHORARIO, por CODHOR.
       -- O ReadView do EduHorarioTurmaData devolve tudo junto e engana.
       INNER JOIN SHORARIO H       ON H.CODCOLIGADA     = HT.CODCOLIGADA
                                  AND H.CODHOR          = HT.CODHOR
       INNER JOIN STURMADISC TD    ON TD.CODCOLIGADA    = HT.CODCOLIGADA
                                  AND TD.IDTURMADISC    = HT.IDTURMADISC
       INNER JOIN SPLETIVO PL      ON PL.CODCOLIGADA    = HT.CODCOLIGADA
                                  AND PL.IDPERLET       = HT.IDPERLET
       -- LEFT de propósito: a maioria das faltas não tem justificativa (medido:
       -- 100% sem). INNER sumiria com todas elas, silenciosamente.
       LEFT  JOIN SJUSTIFICATIVAFALTA J ON J.CODCOLIGADA          = F.CODCOLIGADA
                                       AND J.IDJUSTIFICATIVAFALTA = F.IDJUSTIFICATIVAFALTA
WHERE  F.CODCOLIGADA = :CODCOLIGADA
  AND  PL.CODPERLET  = :CODPERLET
ORDER BY F.IDTURMADISC, F.DATA, F.RA;

-- NÃO acrescente TOP nem LIMIT. A Sentença de alunos nasceu com `SELECT TOP 30`
-- e truncou o roster silenciosamente — apareciam 2 turmas de 185.
--
-- NÃO filtre por PRESENCA nem por campus. O primeiro esconde o que medimos; o
-- segundo é responsabilidade do middleware.
--
-- Volume conhecido: 21.300 linhas nos dois campi, ano letivo 2026 até 01/07.
-- Não precisa de parâmetro de data.
