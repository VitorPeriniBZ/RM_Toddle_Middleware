/**
 * PRONTIDÃO — a pergunta que o `/health` não responde.
 *
 * ─── DUAS PERGUNTAS DIFERENTES, DUAS ROTAS ──────────────────────────────────
 *
 *   /health         "o processo está vivo?"          -> SEMPRE 200
 *   /health/ready   "ele consegue trabalhar agora?"  -> 503 se não
 *
 * `/health` sempre devolveu 200, inclusive com o Postgres fora, e isso parecia
 * defeito. Não é — mas também não era decisão: era ausência de decisão, porque
 * ninguém tinha escrito qual das duas perguntas aquela rota respondia.
 *
 * ─── POR QUE O `/health` NÃO VIRA 503 ───────────────────────────────────────
 *
 * O healthcheck do Coolify aponta para `/health` e reinicia o container quando
 * ele falha. Fazer o `/health` cair junto com o Postgres criaria um
 * crashloop que não conserta nada:
 *
 *   1. reiniciar o processo não levanta banco de dados caído;
 *   2. a cópia de base do RM acontece periodicamente neste ambiente, e nela as
 *      dependências ficam fora por minutos — seria crashloop autoinfligido,
 *      programado;
 *   3. quando o banco volta, N containers reiniciando em laço batem nele todos
 *      ao mesmo tempo.
 *
 * Reinício é a resposta certa quando o defeito é DO PROCESSO — vazamento de
 * memória, event loop travado. Não é quando a dependência caiu.
 *
 * ─── O QUE SAI NO CORPO, E O QUE NÃO SAI ────────────────────────────────────
 *
 * Esta rota é PÚBLICA, como o `/health`. Sai o mínimo que um monitor anônimo
 * precisa para paginar a pessoa certa: qual dependência, em que estado. NÃO sai
 * o texto do erro — ele carrega host, porta e mensagem interna
 * (`connect ECONNREFUSED 10.x.x.x:5432`), e o contrato fixado no P0-2 é que
 * detalhe operacional mora atrás de autenticação, em `/config`.
 */

/**
 * ─── PRONTIDÃO TEM PRAZO ────────────────────────────────────────────────────
 *
 * Medido em 29/09/2026 com Postgres e Toddle inalcançáveis: a checagem levou
 * **26 segundos** para responder. A causa é legítima — o `toddleClient` tem
 * escada de retry com backoff (5 tentativas), que é o comportamento certo para
 * um SYNC, onde insistir vale a pena.
 *
 * Para uma sonda de prontidão é o comportamento errado, e de um jeito que se
 * volta contra o propósito: monitor externo tem timeout de 5 a 10 segundos.
 * Ele veria TIMEOUT, não 503. "Não respondeu" e "respondeu 'não estou pronto'"
 * são diagnósticos diferentes — o primeiro manda investigar a rede até a API, o
 * segundo diz exatamente qual dependência caiu.
 *
 * Então a prontidão tem orçamento próprio: estourou, a dependência conta como
 * FORA. Não é chute — uma dependência que não responde em 3s não serve para
 * atender requisição de usuário, que é a pergunta que esta rota faz.
 */
export const PRAZO_DA_CHECAGEM_MS = 3_000;

/**
 * Corre a checagem contra o relógio. Nunca lança.
 *
 * O `Promise.race` não CANCELA a checagem perdedora — ela continua no ar e
 * termina sozinha. É aceitável aqui: o `checarToddleComCache` grava o resultado
 * no cache quando terminar, então a corrida perdida ainda aproveita, e a
 * próxima sonda já encontra a resposta pronta.
 */
export async function comPrazo(
  nome: string,
  checar: () => Promise<DependenciaAvaliada>,
  prazoMs: number = PRAZO_DA_CHECAGEM_MS,
): Promise<DependenciaAvaliada> {
  let timer: NodeJS.Timeout | undefined;
  const estourou = new Promise<DependenciaAvaliada>((resolve) => {
    timer = setTimeout(() => resolve({ nome, estado: 'falha' }), prazoMs);
  });
  try {
    return await Promise.race([checar(), estourou]);
  } catch {
    // `checarDependencia` já não lança, mas prontidão não é lugar de descobrir
    // que alguém mudou isso: aqui, exceção é dependência fora.
    return { nome, estado: 'falha' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Mesmos três estados de `checarDependencia`. `limitado` não é queda. */
export type EstadoDependencia = 'ok' | 'limitado' | 'falha';

export interface DependenciaAvaliada {
  nome: string;
  estado: EstadoDependencia;
}

export interface Prontidao {
  pronto: boolean;
  /** 200 ou 503. É o que a rota devolve. */
  status: 200 | 503;
  /** Corpo público: nome e estado, nunca o texto do erro. */
  dependencias: DependenciaAvaliada[];
  /** Só as que estão FORA. Vazio quando pronto. */
  fora: string[];
  /** Só as degradadas. Não impedem prontidão. */
  degradadas: string[];
}

/**
 * Decide, e só isso. Sem I/O, sem log, sem alerta — dá para testar o critério
 * sem Postgres nem Toddle, que é o ponto.
 *
 * ─── `limitado` NÃO É QUEDA, E ESSA É A REGRA QUE MAIS ERRA ─────────────────
 *
 * O Toddle responde 429 com janela de 300s quando pedimos demais. Até 11/09
 * este projeto tratava isso como falha e a tela dizia "1 FORA DO AR" — o
 * Toddle estava de pé, nós é que pedimos demais, e quem lia ia procurar defeito
 * no lugar errado.
 *
 * Um 503 por rate limit seria a mesma mentira, com consequência maior: o
 * monitor externo pagina alguém de madrugada por uma janela que passa sozinha
 * em cinco minutos. Alarme falso é como um canal de alerta morre.
 */
export function avaliarProntidao(deps: DependenciaAvaliada[]): Prontidao {
  const fora = deps.filter((d) => d.estado === 'falha').map((d) => d.nome);
  const degradadas = deps.filter((d) => d.estado === 'limitado').map((d) => d.nome);
  const pronto = fora.length === 0;

  return {
    pronto,
    status: pronto ? 200 : 503,
    dependencias: deps.map((d) => ({ nome: d.nome, estado: d.estado })),
    fora,
    degradadas,
  };
}

/**
 * O assunto do alerta de dependência fora.
 *
 * ESTÁVEL entre repetições, por contrato: o assunto é a chave da supressão, e
 * um assunto que carregue dado mutável — quantidade, horário, mensagem de erro
 * — produz chave nova a cada checagem e a supressão nunca acontece. Foi
 * exatamente assim que o vigia quase transformou o canal em ruído.
 *
 * As dependências entram ORDENADAS: `postgres,toddle` e `toddle,postgres` são o
 * mesmo incidente, e sem ordenar seriam dois assuntos — duas notificações pela
 * mesma coisa, dependendo da ordem em que o `Promise.all` resolveu.
 */
export function assuntoDeDependenciaFora(fora: string[]): string {
  return `Dependência fora: ${[...fora].sort().join(', ')}`;
}
