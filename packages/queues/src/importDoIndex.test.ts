import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Quem roda e PRECISA ENCERRAR não pode importar o index deste pacote.
 *
 * ─── POR QUE ESTE TESTE EXISTE ──────────────────────────────────────────────
 *
 * `connection.ts` abre a conexão Redis no topo do módulo, e o `index.ts`
 * reexporta esse módulo. Então `import ... from '@rm-toddle/queues'` abre um
 * socket só por existir — e um socket aberto segura o event loop.
 *
 * Para um worker isso é irrelevante: ele fica de pé mesmo. Para um script que
 * termina, é fatal. E o `preflight` roda dentro do container `init` do deploy:
 *
 *     command: sh -c "npm run preflight && npm run db:migrate && npm run schedule"
 *
 * Se ele não encerra, o `&&` nunca acontece e o deploy fica em "Waiting" para
 * sempre. Aconteceu em 11/09/2026 — e a armadilha já estava escrita em
 * `cronProfessor.ts` desde antes, o que não impediu ninguém de repetir.
 *
 * Comentário não segura isso; teste segura.
 *
 * ─── O QUE FAZER QUANDO ESTE TESTE FALHAR ───────────────────────────────────
 *
 * Importe o MÓDULO direto, não o index: `@rm-toddle/queues/src/fluxos` e
 * `@rm-toddle/queues/src/names` são constantes puras, sem efeito colateral.
 * Se precisar de fila ou conexão de verdade num script que termina, feche-a
 * explicitamente ao final.
 */

/** Arquivos que rodam num processo que TEM de encerrar sozinho. */
const QUE_PRECISAM_ENCERRAR = [
  'apps/worker/src/scripts/preflight.ts',
];

const RAIZ = resolve(__dirname, '../../..');

/** `from '@rm-toddle/queues'` — o index. Subcaminho (`/src/...`) é permitido. */
const IMPORT_DO_INDEX = /from\s+['"]@rm-toddle\/queues['"]/;

describe('scripts que precisam encerrar não importam o index de queues', () => {
  it.each(QUE_PRECISAM_ENCERRAR)('%s', (caminho) => {
    const fonte = readFileSync(resolve(RAIZ, caminho), 'utf8');
    const achou = IMPORT_DO_INDEX.test(fonte);

    expect(
      achou,
      `${caminho} importa o INDEX de @rm-toddle/queues, que abre a conexão Redis ao ser ` +
        'carregado. Esse processo nunca encerra, e o container `init` do deploy trava em ' +
        '"Waiting". Importe o módulo direto: @rm-toddle/queues/src/fluxos',
    ).toBe(false);
  });

  // Se o index deixar de abrir Redis, este teste inteiro perde a razão de ser —
  // e é melhor descobrir isso por uma falha aqui do que mantê-lo por inércia.
  it('o index realmente abre a conexão (senão esta guarda é folclore)', () => {
    const connection = readFileSync(resolve(RAIZ, 'packages/queues/src/connection.ts'), 'utf8');
    const index = readFileSync(resolve(RAIZ, 'packages/queues/src/index.ts'), 'utf8');
    expect(connection).toMatch(/new IORedis\(/);
    expect(index).toMatch(/export \* from '\.\/connection'/);
  });
});
