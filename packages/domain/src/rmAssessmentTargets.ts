import { logger, tenantConfig } from '@rm-toddle/config';
import { wsDataServerClient } from '@rm-toddle/integrations';
import { chaveComposta } from './chaveComposta';
import { chaveNaturalNotaAvaliacao } from './provaXml';
import { canonizarNota } from './notaCanonica';

const cfg = tenantConfig;

/** Uma avaliação que já existe no RM. */
export interface ProvaRm {
  idTurmaDisc: string;
  codEtapa: string;
  codProva: string;
  descricao: string;
  valor: string | null;
}

/** Uma nota de avaliação que já existe no RM. */
export interface NotaAvaliacaoRm {
  idTurmaDisc: string;
  codEtapa: string;
  codProva: string;
  ra: string;
  nota: string | null;
  descProva: string | null;
}

/**
 * O que o RM já tem do lado das AVALIAÇÕES: as provas e as notas delas.
 *
 * ─── SEM AUTORIA, E ISSO MUDA A DECISÃO DE ESCRITA ──────────────────────────
 *
 * O `ReadView` de `EduNotasData` **não expõe `RECCREATEDBY`/`RECMODIFIEDBY`** —
 * medido em 09/09/2026, o retorno tem 34 campos e nenhum deles é de auditoria.
 * É a mesma lacuna do dataserver de frequência, e a razão pela qual este projeto
 * lê o estado do RM por Sentença quando precisa de autoria.
 *
 * Consequência aceita: sem autoria, `decidirEscrita` recebe `EstadoNoRm` sem
 * `autoriaEhIntegracao`, e a única evidência de que uma nota é nossa passa a ser
 * a proveniência local. Nota que exista no RM sem proveniência nossa vira
 * `CONFLITO_HUMANO` — conservador, e o lado certo para errar: preferimos abrir
 * pendência sobre nota de professor do que sobrescrevê-la.
 *
 * ─── LOTES DE 25 NO `IN` ────────────────────────────────────────────────────
 *
 * Mesmo teto que a leitura de nota de etapa: `IN` grande estoura o ReadView.
 */
export class RmAssessmentTargets {
  private constructor(
    /** `${idTurmaDisc}|${codEtapa}` -> provas daquela etapa. */
    private readonly provasPorEtapa: Map<string, ProvaRm[]>,
    /** chave natural -> nota existente. */
    readonly notasPorChave: Map<string, NotaAvaliacaoRm>,
    readonly totalProvas: number,
    readonly totalNotas: number,
    /**
     * Linhas do RM descartadas por componente de chave ausente ou vazio.
     *
     * Contado e exposto pelo mesmo motivo de `semChave` na frequência e nas
     * notas: uma nota que existe no RM e que não conseguimos indexar é uma
     * nota que a projeção vai considerar inexistente — e escrever por cima.
     * Descartar contém o dano pior (chave degradada casando com a avaliação
     * ERRADA de outro aluno), mas não o elimina, então precisa ser VISÍVEL.
     */
    readonly semChave: number,
  ) {}

  static async carregar(idsTurmaDisc: string[], codFilial: string): Promise<RmAssessmentTargets> {
    if (idsTurmaDisc.length === 0) {
      throw new Error(
        'RmAssessmentTargets.carregar recebeu lista vazia de turma-disciplina. ' +
          'Sem escopo não há projeção possível — isto é recusa, não "carregar tudo".',
      );
    }

    const emEscopo = new Set(idsTurmaDisc);
    const provasPorEtapa = new Map<string, ProvaRm[]>();
    const notasPorChave = new Map<string, NotaAvaliacaoRm>();
    let totalProvas = 0;
    let totalNotas = 0;
    let semChave = 0;

    const LOTE = 25;
    const lista = [...emEscopo];
    for (let i = 0; i < lista.length; i += LOTE) {
      const fatia = lista.slice(i, i + LOTE).join(',');

      for (const row of await wsDataServerClient.readView(
        'EduProvasData',
        `SProvas.CODCOLIGADA=${cfg.rm.escopo.coligada} AND SProvas.IDTURMADISC IN (${fatia})`,
        'SProvas',
        codFilial,
      )) {
        if (row.TIPOETAPA !== 'N') continue;
        if (!emEscopo.has(row.IDTURMADISC)) continue;
        /*
         * Lidos UMA vez e sem `String()`: `String(row.X)` de campo ausente
         * produz a palavra "undefined", que é valor com cara de valor. Aqui a
         * leitura fica crua e a validação é de `chaveComposta`, logo abaixo —
         * um lugar só decide o que é componente válido.
         */
        const prova: ProvaRm = {
          idTurmaDisc: row.IDTURMADISC,
          codEtapa: row.CODETAPA,
          codProva: row.CODPROVA,
          descricao: String(row.DESCRICAO ?? ''),
          valor: row.VALOR ?? null,
        };
        /*
         * A chave deixou de ser template literal cru. Antes, um `IDTURMADISC`
         * ou `CODETAPA` ausente virava a palavra "undefined" na chave — e o
         * consumidor (`provasDe`) devolve `?? []`, o que faz `proximoCodProva`
         * voltar 1, a guarda anti-duplicata por descrição ficar vazia, e o
         * sistema CRIAR uma avaliação que já existe, com CODPROVA colidindo.
         *
         * Falha ABERTA, no registro acadêmico. Ver `chaveComposta`.
         */
        let chave: string;
        try {
          chave = chaveComposta('provasPorEtapa', {
            idTurmaDisc: prova.idTurmaDisc,
            codEtapa: prova.codEtapa,
          });
        } catch (err) {
          // Mesma disciplina do índice de notas: uma prova ilegível não pode
          // custar o carregamento das outras 244.
          semChave += 1;
          logger.warn(
            { erro: (err as Error).message.slice(0, 160) },
            'Prova sem componente da chave — descartada. Ela existe no RM e o índice não vai ' +
              'enxergá-la, então a criação de avaliação pode duplicar',
          );
          continue;
        }
        const atual = provasPorEtapa.get(chave);
        if (atual) atual.push(prova);
        else provasPorEtapa.set(chave, [prova]);
        totalProvas += 1;
      }

      for (const row of await wsDataServerClient.readView(
        'EduNotasData',
        `SNotas.CODCOLIGADA=${cfg.rm.escopo.coligada} AND SNotas.IDTURMADISC IN (${fatia})`,
        'SNotas',
        codFilial,
      )) {
        if (row.TIPOETAPA !== 'N') continue;
        if (!emEscopo.has(row.IDTURMADISC)) continue;
        // Idem: leitura crua, validação em `chaveNaturalNotaAvaliacao`.
        const nota: NotaAvaliacaoRm = {
          idTurmaDisc: row.IDTURMADISC,
          codEtapa: row.CODETAPA,
          codProva: row.CODPROVA,
          ra: row.RA,
          // Canônica JÁ NA LEITURA: o RM devolve "9.0000" e o Toddle "9".
          // Comparar os dois como texto marcava toda nota nossa como
          // "editada por fora". Ver `notaCanonica`.
          nota: canonizarNota(row.NOTA),
          descProva: row.DESCPROVA ?? null,
        };
        /*
         * A chave RECUSA componente vazio ou `"undefined"` — ver a guarda em
         * `chaveNaturalNotaAvaliacao`. Aqui a recusa vira descarte da linha,
         * não morte do carregamento: uma nota ilegível não pode custar as
         * outras 3.506.
         */
        try {
          notasPorChave.set(
            chaveNaturalNotaAvaliacao({
              codColigada: String(cfg.rm.escopo.coligada),
              codProva: nota.codProva,
              codEtapa: nota.codEtapa,
              idTurmaDisc: nota.idTurmaDisc,
              ra: nota.ra,
            }),
            nota,
          );
        } catch (err) {
          semChave += 1;
          logger.warn(
            { idTurmaDisc: nota.idTurmaDisc, erro: (err as Error).message.slice(0, 160) },
            'Nota de avaliação sem componente da chave — descartada. Ela existe no RM e o ' +
              'cruzamento não vai enxergá-la',
          );
          continue;
        }
        totalNotas += 1;
      }
    }

    logger.info(
      { turmaDiscEmEscopo: emEscopo.size, provas: totalProvas, notasDeAvaliacao: totalNotas },
      'Índice de avaliações do RM carregado',
    );

    return new RmAssessmentTargets(provasPorEtapa, notasPorChave, totalProvas, totalNotas, semChave);
  }

  provasDe(idTurmaDisc: string, codEtapa: string): ProvaRm[] {
    /*
     * A MESMA função do produtor, e não um template literal paralelo: duas
     * fórmulas para a mesma chave divergem no dia em que alguém melhora uma —
     * é o motivo de `chaveNaturalDeFalta` chamar `chaveNaturalRm`.
     *
     * O `?? []` continua aqui e é falha ABERTA por natureza: quem consulta não
     * distingue "esta etapa não tem prova" de "não consegui indexar". O que
     * mudou é que o segundo caso não chega mais até aqui — o produtor recusa a
     * chave incompleta na origem.
     */
    return this.provasPorEtapa.get(chaveComposta('provasDe', { idTurmaDisc, codEtapa })) ?? [];
  }

  /**
   * O próximo `CODPROVA` livre naquela turma-disciplina e etapa.
   *
   * `CODPROVA` é sequencial POR (turma-disciplina, etapa) — existe uma "prova 1"
   * em cada uma das 186 turmas. Alocar `max + 1` em vez de um contador global é
   * o que mantém a numeração parecida com a que um humano faria na tela.
   */
  proximoCodProva(idTurmaDisc: string, codEtapa: string): number {
    const existentes = this.provasDe(idTurmaDisc, codEtapa).map((p) => Number(p.codProva));
    const max = existentes.length ? Math.max(...existentes) : 0;
    return max + 1;
  }

  /** Descrições já usadas naquela etapa, para não criar prova duplicada por nome. */
  descricoesDe(idTurmaDisc: string, codEtapa: string): Map<string, string> {
    const m = new Map<string, string>();
    for (const p of this.provasDe(idTurmaDisc, codEtapa)) m.set(p.descricao.trim(), p.codProva);
    return m;
  }
}
