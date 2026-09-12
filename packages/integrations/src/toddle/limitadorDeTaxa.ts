import IORedis from 'ioredis';
import { env, logger, tenantConfig } from '@rm-toddle/config';

/**
 * LIMITADOR DE TAXA COMPARTILHADO do Toddle.
 *
 * ─── POR QUE ESPAÇAR CRON NÃO BASTA ─────────────────────────────────────────
 *
 * A janela de rate limit é da ORGANIZAÇÃO, não do fluxo: alunos, professores e
 * notas gastam a mesma cota. Espaçar horários é controle em malha aberta e não
 * cobre o que de fato quebrou em 11/09/2026 — um sync MANUAL às 11:55 somado ao
 * cron das 12:00 estourou a janela, e o lote 3 do sync de alunos falhou com
 * "17/50 alunos falharam (HTTP 429)".
 *
 * Cron não controla execução manual, retry, backfill nem acúmulo pós-downtime.
 * E `avaliarFolga` mede INSTANTE de disparo, não OCUPAÇÃO: o sync de aluno ocupa
 * ~4 min, e essa duração cresce com a matrícula, então a folga real encolhe
 * sozinha enquanto a guarda continua dizendo que está tudo bem.
 *
 * Aqui o controle é em malha fechada, no ponto da chamada HTTP. Cobre
 * automaticamente manual, retry, script ad-hoc e fluxo novo — sem ninguém
 * precisar lembrar de nada.
 *
 * ─── POR QUE NÃO O `limiter` DO BULLMQ ──────────────────────────────────────
 *
 * Porque ele limita INÍCIO DE JOB, não chamada HTTP. Um job do sync de alunos
 * faz ~260 chamadas e conta como 1. Ele também é por fila, e são três filas
 * distintas disputando a mesma cota — cada uma com seu limiter não compartilha
 * proteção nenhuma.
 *
 * ─── A CONEXÃO É PREGUIÇOSA, E ISSO É REQUISITO ─────────────────────────────
 *
 * `packages/queues` abre a conexão Redis no topo do módulo, e importar aquele
 * pacote de um script fazia o processo nunca encerrar — o preflight travou o
 * deploy por isso. Este módulo é importado pelo cliente do Toddle, que é usado
 * por CLIs de leitura que não deveriam nem falar com o Redis. Então a conexão só
 * nasce na primeira chamada que precisa dela.
 *
 * ─── O NÚMERO DA COTA É ESTIMATIVA, E ESTÁ DECLARADO COMO TAL ───────────────
 *
 * O Toddle responde 429 dizendo "try again after 300 seconds" — o CASTIGO, não a
 * COTA. Não sabemos quantas chamadas cabem na janela. O que se mediu:
 *
 *   - ~260 chamadas em ~4 min (um sync de alunos sozinho) passa;
 *   - dois syncs sobrepostos na mesma janela falham.
 *
 * Logo a cota está em algum ponto acima de 260 e abaixo de ~520. O default é 250
 * por janela, deliberadamente abaixo do menor valor que sabemos passar, e é
 * ajustável por ambiente. Quem descobrir o número real deve corrigi-lo.
 *
 * O balde é a prevenção, imprecisa por natureza. O COOLDOWN é a rede de
 * segurança, e esse é exato: quando um 429 chega, a própria API diz por quantos
 * segundos ficar quieto, e todo mundo respeita.
 */

const PREFIXO = 'toddle:rate';

/** Espera no máximo isto por uma vaga antes de desistir e deixar o erro subir. */
const ESPERA_MAXIMA_MS = 310_000;

/** Granularidade do sono ao aguardar vaga. */
const PASSO_MINIMO_MS = 50;

const dorme = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let conexao: IORedis | null = null;

/**
 * Quantos comandos estão EM VOO agora. O socket fica `ref` enquanto isto é > 0.
 * Ver a nota abaixo: é o contador que torna o `unref` correto.
 */
let comandosEmVoo = 0;

function sockete(): { ref?: () => void; unref?: () => void } | undefined {
  return (conexao as unknown as { stream?: { ref?: () => void; unref?: () => void } })?.stream;
}

/**
 * Roda um comando com o socket REFERENCIADO, e devolve ao estado ocioso no fim.
 *
 * ─── POR QUE ISTO EXISTE (e por que `unref` sozinho estava ERRADO) ──────────
 *
 * Um socket `unref`ado não segura o event loop NEM ENQUANTO ESPERA RESPOSTA.
 * Se ele for a única coisa pendente, o Node considera que não há mais nada a
 * fazer e ENCERRA no meio do `await` — sem erro, sem exceção, com exit code 13
 * e a promessa nunca resolvida.
 *
 * Foi exatamente o que aconteceu: `npm run escrever:avaliacoes` encerrava em
 * 0,9 s, com exit 0 e SEM IMPRIMIR RELATÓRIO NENHUM. Um comando que some em
 * silêncio é pior que um que trava, porque quem olha conclui "não tinha nada a
 * fazer" — e foi essa a conclusão errada que se tirou do fluxo de notas.
 *
 * A versão anterior deste arquivo afirmava que o `setTimeout` da espera
 * segurava o loop. Segura — mas só enquanto o limitador DORME. Durante o
 * `PTTL` e o `EVAL`, que é a maior parte do tempo, não havia nada referenciado.
 *
 * A correção não é abrir mão do `unref` (sem ele, todo CLI pendura de novo): é
 * referenciar enquanto há trabalho e soltar quando não há. Ocioso, o socket não
 * segura ninguém; em voo, ele segura — que é o comportamento que se quer dos
 * dois lados.
 */
async function comSocketVivo<T>(fn: () => Promise<T>): Promise<T> {
  // A conexão PRIMEIRO: na primeira chamada ela ainda não existe, e referenciar
  // antes de criá-la não referencia nada. O `connect` chegaria com um comando já
  // em voo, não soltaria o socket, e o processo penduraria para sempre — o modo
  // de falha oposto, e igualmente real. Medido.
  redis();
  if (comandosEmVoo === 0) sockete()?.ref?.();
  comandosEmVoo += 1;
  try {
    return await fn();
  } finally {
    comandosEmVoo -= 1;
    if (comandosEmVoo === 0) sockete()?.unref?.();
  }
}

/** A conexão nasce aqui, e só aqui. Ver a nota sobre preguiça no cabeçalho. */
function redis(): IORedis {
  if (!conexao) {
    conexao = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
    conexao.on('error', (err) =>
      logger.warn({ err: err.message }, 'Limitador de taxa: erro na conexão Redis'),
    );

    // ─── `unref` NÃO É OTIMIZAÇÃO: É O QUE IMPEDE O PROCESSO DE PENDURAR ────
    //
    // Um socket aberto segura o event loop, e este módulo é importado pelo
    // cliente do Toddle — ou seja, por dezenas de CLIs de leitura que terminam
    // sozinhos. Sem isto, `npm run ler:notas` imprime o resultado e nunca
    // encerra. Medido: pendurou na primeira tentativa.
    //
    // Exigir que cada script chame `encerrarLimitador()` seria repetir o erro
    // que já travou o preflight neste projeto — basta um esquecido, e quem
    // esquece é sempre o script novo.
    //
    // O `connect` pode chegar com um comando JÁ em voo (o primeiro deles é o
    // que abriu a conexão). Soltar o socket ali mataria esse comando, então só
    // se solta quando de fato não há nada pendente.
    conexao.on('connect', () => {
      if (comandosEmVoo === 0) sockete()?.unref?.();
    });
  }
  return conexao;
}

/**
 * Fecha a conexão explicitamente.
 *
 * Com o `unref` acima, nenhum script PRECISA chamar isto para encerrar — e é
 * assim que tem de ser. Existe para testes, que querem determinismo, e para
 * quem queira devolver o socket antes da hora.
 */
export async function encerrarLimitador(): Promise<void> {
  if (!conexao) return;
  await conexao.quit().catch(() => undefined);
  conexao = null;
}

/**
 * Balde de tokens, atômico.
 *
 * Precisa ser Lua: ler-decidir-escrever em três comandos separados permite que
 * dois workers leiam o mesmo saldo e ambos gastem — que é exatamente o burst que
 * este módulo existe para impedir.
 *
 * Devolve `{concedido, esperaMs}`. Quando não concede, diz quanto falta para o
 * próximo token existir, em vez de mandar o chamador tentar às cegas.
 */
const SCRIPT_BALDE = `
local chave       = KEYS[1]
local capacidade  = tonumber(ARGV[1])
local janelaMs    = tonumber(ARGV[2])
local agoraMs     = tonumber(ARGV[3])

local taxaPorMs = capacidade / janelaMs
local dados = redis.call('HMGET', chave, 'tokens', 'em')
local tokens = tonumber(dados[1])
local em     = tonumber(dados[2])
if tokens == nil then tokens = capacidade end
if em == nil then em = agoraMs end

tokens = math.min(capacidade, tokens + (agoraMs - em) * taxaPorMs)

if tokens < 1 then
  local faltaMs = math.ceil((1 - tokens) / taxaPorMs)
  redis.call('HMSET', chave, 'tokens', tokens, 'em', agoraMs)
  redis.call('PEXPIRE', chave, janelaMs * 2)
  return {0, faltaMs}
end

redis.call('HMSET', chave, 'tokens', tokens - 1, 'em', agoraMs)
redis.call('PEXPIRE', chave, janelaMs * 2)
return {1, 0}
`;

function chaveDoBalde(): string {
  return `${PREFIXO}:${tenantConfig.toddle.organizationId}:balde`;
}
function chaveDoCooldown(): string {
  return `${PREFIXO}:${tenantConfig.toddle.organizationId}:cooldown`;
}

/**
 * Segura a chamada até haver vaga. Retorna quando pode seguir.
 *
 * Ordem importa: o COOLDOWN é conferido primeiro. Se um 429 já chegou, não
 * adianta ter token — a janela inteira está castigada, e gastar token ali seria
 * queimar a chamada.
 *
 * Nunca LANÇA por indisponibilidade do Redis. Um limitador que derruba o sync
 * quando o Redis pisca é pior que não ter limitador: ele transforma um problema
 * de otimização num problema de disponibilidade. Falhou, deixa passar e avisa.
 */
export async function aguardarVagaNoToddle(rotulo = 'toddle'): Promise<void> {
  if (!env.TODDLE_RATE_LIMIT_ATIVO) return;

  const inicio = Date.now();
  const capacidade = env.TODDLE_RATE_LIMIT_MAX;
  const janelaMs = env.TODDLE_RATE_LIMIT_JANELA_S * 1_000;

  for (;;) {
    let esperaMs = 0;
    try {
      const restanteCooldown = await comSocketVivo(() => redis().pttl(chaveDoCooldown()));
      if (restanteCooldown > 0) {
        esperaMs = restanteCooldown;
      } else {
        const r = (await comSocketVivo(() =>
          redis().eval(
            SCRIPT_BALDE,
            1,
            chaveDoBalde(),
            String(capacidade),
            String(janelaMs),
            String(Date.now()),
          ),
        )) as [number, number];
        if (r[0] === 1) return;
        esperaMs = r[1];
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, rotulo },
        'Limitador de taxa indisponível — seguindo SEM limite (o cooldown de 429 ainda protege)',
      );
      return;
    }

    const decorrido = Date.now() - inicio;
    if (decorrido + esperaMs > ESPERA_MAXIMA_MS) {
      logger.warn(
        { rotulo, decorridoMs: decorrido, esperaMs },
        'Limitador: espera passaria do teto — seguindo e deixando o 429 decidir',
      );
      return;
    }
    await dorme(Math.max(esperaMs, PASSO_MINIMO_MS));
  }
}

/**
 * Um 429 chegou: cala TODO MUNDO pela janela que a própria API mandou.
 *
 * Zera o balde junto. Sem isso, os tokens acumulados durante o cooldown fariam
 * todos os fluxos acordarem juntos e dispararem em rajada no instante em que ele
 * expira — abrindo a janela seguinte de 429 imediatamente.
 *
 * `NX` no cooldown: o primeiro 429 manda. Se três chamadas levarem 429 juntas,
 * a janela não é reiniciada três vezes.
 */
export async function registrarRateLimitDoToddle(segundos: number): Promise<void> {
  if (!env.TODDLE_RATE_LIMIT_ATIVO) return;
  const ms = Math.max(segundos, 1) * 1_000;
  try {
    const novo = await comSocketVivo(() => redis().set(chaveDoCooldown(), '1', 'PX', ms, 'NX'));
    await comSocketVivo(() => redis().hset(chaveDoBalde(), 'tokens', 0, 'em', Date.now()));
    if (novo) {
      logger.warn(
        { segundos, organizacao: tenantConfig.toddle.organizationId },
        'Rate limit do Toddle: TODOS os fluxos em cooldown compartilhado',
      );
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Não foi possível registrar o cooldown de rate limit');
  }
}

/** Quanto falta do cooldown, em ms. `0` = liberado. Para diagnóstico e tela. */
export async function cooldownRestanteMs(): Promise<number> {
  try {
    const t = await comSocketVivo(() => redis().pttl(chaveDoCooldown()));
    return t > 0 ? t : 0;
  } catch {
    return 0;
  }
}
