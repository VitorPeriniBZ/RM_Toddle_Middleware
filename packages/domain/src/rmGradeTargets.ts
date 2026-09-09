import { logger, tenantConfig } from '@rm-toddle/config';
import { wsDataServerClient } from '@rm-toddle/integrations';
import type { EtapaNotaRm } from './gradeProjection';

const cfg = tenantConfig;

/** "2026-05-15 00:00:00" / ISO -> "2026-05-15". Devolve null para vazio. */
function soData(valor: string | null | undefined): string | null {
  if (!valor) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(valor).trim());
  return m ? m[1] : null;
}

const ehSim = (v: string | null | undefined): boolean =>
  ['S', 'SIM', '1', 'TRUE'].includes(String(v ?? '').trim().toUpperCase());

/**
 * As etapas de NOTA do RM — o destino da escrita, e quem responde três perguntas
 * que a projeção precisa: a etapa existe para esta turma-disciplina, ela aceita
 * digitação, e qual é a vigência dela (para o teste de janela da D2).
 *
 * ─── `TIPOETAPA='N'`, E O FILTRO QUE NÃO PODE FALTAR ────────────────────────
 *
 * `SETAPAS` guarda as etapas de nota e de falta na mesma tabela, discriminadas
 * por `TIPOETAPA`. Sem o filtro, a etapa de FALTA entra no índice de nota com o
 * mesmo `CODETAPA`, e o de-para acharia duas etapas para o mesmo ordinal.
 *
 * `PERMITEDIGITACAO='S'` é o segundo filtro obrigatório: sem ele entra a etapa
 * calculada, que cobre o ano inteiro e sobrepõe as três dos trimestres — a mesma
 * armadilha já documentada no índice de frequência.
 *
 * ─── CASE MISTO NO ELEMENTO-LINHA ──────────────────────────────────────────
 *
 * O elemento é `SEtapas`, não `SETAPAS`. Maiúsculas devolvem ZERO linhas sem
 * erro, o que parece tabela vazia. Já custou diagnóstico neste projeto.
 */
export class RmGradeTargets {
  private constructor(
    /** `${idTurmaDisc}|${codEtapa}` -> etapa. */
    readonly etapas: Map<string, EtapaNotaRm>,
    readonly totalEtapas: number,
    /** Turmas-disciplina em escopo que não têm nenhuma etapa de nota digitável. */
    readonly semEtapaDeNota: string[],
  ) {}

  static async carregar(idsTurmaDisc: string[], codFilial: string): Promise<RmGradeTargets> {
    if (idsTurmaDisc.length === 0) {
      throw new Error(
        'RmGradeTargets.carregar recebeu lista vazia de turma-disciplina. ' +
          'Sem escopo não há projeção possível — isto é recusa, não "carregar tudo".',
      );
    }

    const emEscopo = new Set(idsTurmaDisc);
    const etapas = new Map<string, EtapaNotaRm>();
    let total = 0;

    // O `IN` grande estoura no ReadView — a leitura das notas já mediu isso e
    // usa lotes de ~25. Mesmo teto aqui.
    const LOTE = 25;
    const lista = [...emEscopo];
    for (let i = 0; i < lista.length; i += LOTE) {
      const fatia = lista.slice(i, i + LOTE);
      const brutas = await wsDataServerClient.readView(
        'EduEtapasData',
        `SETAPAS.CODCOLIGADA=${cfg.rm.escopo.coligada} AND SETAPAS.IDTURMADISC IN (${fatia.join(',')})`,
        'SEtapas',
        codFilial,
      );

      for (const row of brutas) {
        const idTurmaDisc = row.IDTURMADISC;
        if (!emEscopo.has(idTurmaDisc)) continue;
        if (row.TIPOETAPA !== 'N') continue;
        if (!ehSim(row.PERMITEDIGITACAO)) continue;

        const dtInicio = soData(row.DTINICIO);
        const dtFim = soData(row.DTFIM);
        if (!dtInicio || !dtFim) {
          logger.warn(
            { idTurmaDisc, codEtapa: row.CODETAPA },
            'Etapa de nota sem vigência no RM — fora do índice, e a projeção vai recusar',
          );
          continue;
        }

        etapas.set(`${idTurmaDisc}|${row.CODETAPA}`, {
          idTurmaDisc,
          codEtapa: String(row.CODETAPA),
          dtInicio,
          dtFim,
          permiteDigitacao: true,
          disponivelAlunos: ehSim(row.DISPONIVELALUNOS),
          aulasDadas: row.AULASDADAS ?? null,
        });
        total += 1;
      }
    }

    const semEtapaDeNota = [...emEscopo].filter(
      (id) => ![...etapas.values()].some((e) => e.idTurmaDisc === id),
    );

    logger.info(
      {
        turmaDiscEmEscopo: emEscopo.size,
        etapasDeNota: total,
        liberadas: [...etapas.values()].filter((e) => e.disponivelAlunos).length,
        semEtapaDeNota: semEtapaDeNota.length,
      },
      'Índice de etapas de nota do RM carregado',
    );

    return new RmGradeTargets(etapas, total, semEtapaDeNota);
  }

  /** O `AULASDADAS` que o RM já tem, para ecoar se o SaveRecord exigir. */
  aulasDadasDe(idTurmaDisc: string, codEtapa: string): string | null {
    return this.etapas.get(`${idTurmaDisc}|${codEtapa}`)?.aulasDadas ?? null;
  }

  /** Vigências distintas encontradas, para o relatório do ensaio. */
  vigencias(): string[] {
    return [...new Set([...this.etapas.values()].map((e) => `etapa ${e.codEtapa}: ${e.dtInicio}→${e.dtFim}`))].sort();
  }
}
