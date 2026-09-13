import { spawn } from 'node:child_process';
import { connect, createServer, type Server } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { URL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '@rm-toddle/config';

/**
 * O limitador tem de deixar o processo VIVO durante a chamada e MORRER depois.
 *
 * ─── AS DUAS MANEIRAS DE ERRAR SÃO OPOSTAS ──────────────────────────────────
 *
 *   1. socket referenciado à toa  → o processo NUNCA encerra. Já travou o
 *      container `init` do deploy, que ficou em "Waiting" para sempre.
 *   2. socket `unref`ado EM VOO   → o Node não vê mais nada pendente e encerra
 *      NO MEIO do `await`: sem erro, sem exceção, com a promessa nunca
 *      resolvida e exit code 0.
 *
 * O caso 2 foi real: `npm run escrever:avaliacoes` saía em 0,9 s sem imprimir
 * relatório nenhum, e disso se concluiu "não havia nada a escrever". Um comando
 * que some em silêncio é pior que um que trava, porque produz uma conclusão
 * errada em vez de um sintoma.
 *
 * ─── POR QUE O PROXY COM ATRASO (e não um teste "normal") ───────────────────
 *
 * O caso 2 é uma CORRIDA: o processo só morre se o event loop esvaziar antes de
 * a resposta chegar. Contra um Redis local, que responde em menos de 1 ms, o bug
 * NÃO se manifesta — medido: a versão defeituosa passa. Um teste assim seria
 * verde e vazio, que é pior que não ter teste.
 *
 * Então o Redis do processo filho é um proxy que atrasa a resposta em 150 ms. Aí
 * a corrida tem vencedor fixo: com o socket solto em voo o filho morre calado, e
 * com ele referenciado o filho chega ao fim. Os dois desfechos são afirmações
 * verificáveis, e não questão de sorte na máquina de quem rodou.
 *
 * Um mock não serve para nada disto: dentro do Vitest o runner segura o event
 * loop, então o socket `unref`ado nunca é a última referência. Tem de ser um
 * processo de verdade, que termina.
 */

const RAIZ = resolve(__dirname, '../../../..');
const ATRASO_MS = 150;
const TEMPO_LIMITE_MS = 20_000;

let proxy: Server;
let urlDoProxy: string;

beforeAll(async () => {
  const alvo = new URL(env.REDIS_URL);
  const porta = Number(alvo.port || 6379);
  const host = alvo.hostname;

  proxy = createServer((cliente) => {
    const servidor = connect(porta, host);
    cliente.pipe(servidor);
    // Só a RESPOSTA é atrasada: é o intervalo em que o comando está em voo.
    servidor.on('data', (b) => setTimeout(() => cliente.write(b), ATRASO_MS));
    const fecha = (): void => {
      cliente.destroy();
      servidor.destroy();
    };
    cliente.on('error', fecha);
    servidor.on('error', fecha);
    cliente.on('close', fecha);
  });

  await new Promise<void>((ok) => proxy.listen(0, '127.0.0.1', ok));
  const end = proxy.address() as { port: number };
  urlDoProxy = `redis://127.0.0.1:${end.port}`;
});

afterAll(async () => {
  await new Promise<void>((ok) => proxy.close(() => ok()));
});

/**
 * Roda o script num processo filho e espera.
 *
 * ASSÍNCRONO de propósito: `spawnSync` bloqueia o event loop DESTE processo, e o
 * proxy com atraso vive aqui. Com ele, o proxy nunca encaminha resposta nenhuma
 * e o filho pendura esperando um Redis que ninguém atende — o teste falharia
 * sempre, inclusive com o código correto. Custou uma investigação inteira.
 */
async function rodarScript(corpo: string): Promise<{ encerrouSozinho: boolean; status: number | null; saida: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'limitador-'));
  const arquivo = join(dir, 'script.ts');
  writeFileSync(arquivo, corpo, 'utf8');

  const filho = spawn(join(RAIZ, 'node_modules/.bin/tsx'), [arquivo], {
    cwd: RAIZ,
    // Sem PATH e HOME o tsx nem inicia no filho — montar o ambiente de um spawn
    // não é ler config, e a exceção é declarada na própria linha.
    env: { ...process.env, TODDLE_RATE_LIMIT_ATIVO: 'true', REDIS_URL: urlDoProxy }, // env-do-filho: ambiente do spawn
  });

  let saida = '';
  filho.stdout.on('data', (b) => (saida += String(b)));
  filho.stderr.on('data', (b) => (saida += String(b)));

  // Quem matou o processo é a informação decisiva, e não dá para tirá-la do
  // código de saída: no macOS um filho morto por SIGTERM chega aqui com
  // `signal` nulo e status 143, indistinguível de uma saída própria.
  let matamosNos = false;
  const carrasco = setTimeout(() => {
    matamosNos = true;
    filho.kill('SIGKILL');
  }, TEMPO_LIMITE_MS);

  const status = await new Promise<number | null>((ok) => {
    filho.on('close', (c) => {
      clearTimeout(carrasco);
      ok(c);
    });
  });

  return { encerrouSozinho: !matamosNos, status, saida };
}

const CAMINHO = resolve(__dirname, 'limitadorDeTaxa').replace(/\\/g, '/');

describe('o limitador não mata nem pendura o processo que o usa', () => {
  it('chega ao fim mesmo com o Redis lento, e encerra sozinho', async () => {
    const { encerrouSozinho, status, saida } = await rodarScript(`
      import { aguardarVagaNoToddle } from '${CAMINHO}';

      async function main() {
        await aguardarVagaNoToddle('primeira');
        await aguardarVagaNoToddle('segunda');
        console.log('CHEGOU-AO-FIM');
      }
      main().catch((e) => { console.error(e); process.exitCode = 1; });
    `);

    expect(
      encerrouSozinho,
      'o processo não encerrou sozinho: o socket ficou referenciado mesmo ocioso — foi isto que ' +
        'travou o container `init` do deploy em "Waiting"',
    ).toBe(true);

    expect(
      saida,
      'o processo morreu ANTES de terminar o await. O socket estava `unref`ado enquanto o comando ' +
        'Redis estava em voo, então o Node concluiu que não havia mais nada a fazer e encerrou no ' +
        'meio — sem erro e sem saída, o modo de falha mais enganoso que existe',
    ).toContain('CHEGOU-AO-FIM');

    expect(status).toBe(0);
  });
});
