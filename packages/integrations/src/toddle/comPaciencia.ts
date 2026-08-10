import { logger } from '@rm-toddle/config';

const dorme = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Espera a JANELA DE RATE LIMIT do Toddle liberar, e retenta.
 *
 * O limite pune com 300 segundos (medido primeiro no trabalho dos timetable
 * slots; a mensagem é `"User requests rate limit is reached, please try again
 * after 300 seconds"`). Como o Toddle manda os segundos só no CORPO e não em
 * header `Retry-After`, o número sai por regex — feio, e o único caminho.
 *
 * ─── POR QUE NÃO ESTÁ DENTRO DO CLIENTE ─────────────────────────────────────
 *
 * O `ToddleClient.withRetry` faz backoff de ~15s no máximo, e isso é
 * DELIBERADO: um cliente que dormisse 5 minutos em silêncio travaria o worker de
 * alunos e o shadow mode junto. A espera longa é **opt-in**, para scripts de
 * carga em lote que podem se dar ao luxo de esperar.
 *
 * Vivia duplicado em `syncResponsaveis.ts`; promovido aqui em 10/08/2026 porque
 * a primeira versão de `reconciliar:professores` estourou o limite exatamente
 * por não ter esta proteção.
 *
 * Nota: se o volume for grande, **pedir menos vence esperar mais** — trocar N
 * chamadas por uma paginada (ex.: `listEnrollments` em vez de `getClassStaff`
 * por turma) resolve na raiz, e este helper deixa de ser exercitado.
 */
export async function comPaciencia<T>(operacao: () => Promise<T>, maxTentativas = 3): Promise<T> {
  for (let tentativa = 1; ; tentativa += 1) {
    try {
      return await operacao();
    } catch (error) {
      const corpo = JSON.stringify((error as { body?: unknown })?.body ?? '');
      const msg = error instanceof Error ? error.message : String(error);
      if (!/rate limit/i.test(corpo + msg) || tentativa > maxTentativas) throw error;

      // 300 é o fallback observado; a mensagem manda quando traz número.
      const segundos = Number(/after (\d+) seconds/i.exec(corpo)?.[1] ?? 300);
      logger.warn(
        { tentativa, maxTentativas, segundos },
        'Rate limit do Toddle — aguardando a janela liberar',
      );
      await dorme((segundos + 5) * 1_000);
    }
  }
}
