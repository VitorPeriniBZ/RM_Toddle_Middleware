import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A suíte de integração roda UM arquivo por vez, e isso é verificado.
 *
 * ─── O DEFEITO QUE ISTO PEGA ────────────────────────────────────────────────
 *
 * Os arquivos de integração compartilham UM banco e UM tenant. Vários deles
 * limpam tabelas inteiras no `beforeEach`, e três mexem em `membership`, cujo
 * total decide se `decidirOperacao` recusa a auto-aprovação. Rodando em
 * paralelo, um apaga a linha que o outro acabou de inserir.
 *
 * O `vitest.workspace.ts` tinha `fileParallelism: false` DENTRO do bloco do
 * projeto, com um comentário explicando exatamente por que era necessário. No
 * Vitest 2 essa opção é de RAIZ: dentro de um projeto ela é ignorada, em
 * silêncio. A intenção estava escrita e o efeito não acontecia.
 *
 * O sintoma foi um teste do gate de aprovação que falhava uma vez e passava dez.
 * Rodar o arquivo sozinho nunca reproduz — é preciso a suíte inteira — então ele
 * sobreviveu dias como "intermitente", e a investigação foi parar no código de
 * aprovação, que estava certo o tempo todo.
 *
 * ─── POR QUE UM TESTE, E NÃO UM COMENTÁRIO ──────────────────────────────────
 *
 * A bandeira agora vive no `package.json`, longe de onde alguém a procuraria.
 * Um comentário pedindo para não removê-la teria a mesma eficácia do comentário
 * anterior — que também estava certo, e também não impediu nada. Isto falha.
 */

const RAIZ = resolve(__dirname, '../../..');

describe('a suíte de integração é serializada', () => {
  const pkg = JSON.parse(readFileSync(resolve(RAIZ, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  it('`npm run test:integracao` desliga o paralelismo entre arquivos', () => {
    const script = pkg.scripts['test:integracao'] ?? '';
    expect(
      script,
      'o script `test:integracao` precisa de `--no-file-parallelism`. Sem ele os arquivos rodam ' +
        'em paralelo contra o MESMO banco e o mesmo tenant, e limpezas de um apagam as linhas do ' +
        'outro no meio do teste — o que aparece como falha intermitente que não reproduz ' +
        'isoladamente. Não basta pôr `fileParallelism: false` no bloco do projeto em ' +
        'vitest.workspace.ts: no Vitest 2 a opção é de RAIZ e ali é ignorada em silêncio.',
    ).toContain('--no-file-parallelism');
  });

  it('o bloco do projeto NÃO finge serializar por conta própria', () => {
    const ws = readFileSync(resolve(RAIZ, 'vitest.workspace.ts'), 'utf8');
    // Só o que está fora de comentário conta: o arquivo EXPLICA a armadilha, e a
    // explicação cita o nome da opção.
    const semComentarios = ws
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(
      semComentarios,
      'voltou um `fileParallelism` para dentro do bloco do projeto. Ali ele não tem efeito e ' +
        'dá a impressão de que a suíte está serializada quando não está — que é exatamente o ' +
        'estado que custou dias de investigação.',
    ).not.toMatch(/fileParallelism/);
  });
});
