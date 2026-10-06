/**
 * QUANTO CADA ROTA AGUENTA — E POR QUE A CHAVE NÃO É O IP DO CLIENTE.
 *
 * ─── POR QUE ESTE ITEM É O PRIMEIRO DA PILHA ───────────────────────────────
 *
 * Verificado em 05/10/2026: existe um caminho até a origem que **não passa
 * pela borda do Cloudflare**. Enquanto ele existir, toda proteção de borda é
 * contornável — WAF, limite de taxa, bot management — e o limite aqui, na
 * aplicação, é a única camada que não se contorna.
 *
 * O endereço e o comando que demonstram o atalho ficam FORA deste repositório,
 * que é público: ver o incidente de 06/10 no documento interno de operação. O
 * que importa para quem lê este arquivo é a consequência, e ela está acima.
 *
 * ─── A DESCOBERTA QUE MUDOU O DESENHO: O IP DO CLIENTE NÃO É CONFIÁVEL ─────
 *
 * A cadeia tem TRÊS saltos na frente desta API, e **os proxies ANEXAM** ao
 * `X-Forwarded-For` em vez de substituir — o nginx com
 * `$proxy_add_x_forwarded_for` (`apps/web/nginx.conf:26`), e a borda também.
 * Então o que chega é:
 *
 *     X-Forwarded-For: <o que o cliente mandou>, <borda>, <proxy interno>
 *                       ^^^^^^^^^^^^^^^^^^^^^^^
 *                       controlado por quem chama
 *
 * **A entrada mais à esquerda é do cliente.** Com `trustProxy: true`, o
 * `req.ip` passaria a ser esse valor — e aí o limitador não só deixaria de
 * proteger como viraria ARMA: bastaria forjar o `X-Forwarded-For` de outra
 * pessoa para esgotar a cota DELA e tirá-la do ar.
 *
 * Um limitador com chave forjável é pior que limitador nenhum: ele dá a
 * sensação de proteção e entrega um vetor de negação de serviço contra
 * usuário específico.
 *
 * ─── A ESCOLHA, E O QUE ELA CUSTA ─────────────────────────────────────────
 *
 * `trustProxy: 1` — confia em UM salto, o nginx, que é o único par direto da
 * API e o único que este repositório controla. Consequências:
 *
 *   - `X-Forwarded-Proto` volta a funcionar (sem ele a API se vê como `http`,
 *     como o próprio `nginx.conf:28` avisa);
 *   - `req.ip` passa a ser a entrada mais à DIREITA do XFF — o IP do proxy
 *     interno, que é **constante e não forjável**.
 *
 * Constante significa **um balde só para todo mundo**. É limite GLOBAL, não por
 * cliente, e isso é uma escolha consciente: proteger o backend de enxurrada,
 * sem poder ser usado contra um usuário individual.
 *
 * **O que destrava o limite por cliente:** fechar o atalho — nuvem cinza, ou
 * borda restrita às faixas do Cloudflare (`TODO.md` item 0). Fechado o atalho,
 * `CF-Connecting-IP` passa a ser confiável e a chave vira o cliente de
 * verdade. Até lá, não há identidade de cliente confiável nesta topologia, e
 * fingir que há seria o pior dos dois mundos.
 */

export interface LimiteDeRota {
  /** Requisições permitidas na janela. */
  max: number;
  /** Tamanho da janela, em milissegundos. */
  timeWindow: number;
}

const MINUTO = 60_000;

/**
 * O teto geral.
 *
 * ─── DE ONDE SAI O NÚMERO ──────────────────────────────────────────────────
 *
 * A UI é um plano de controle de secretaria — um punhado de pessoas, não os
 * 252 alunos (eles não entram aqui; o destino deles é o Toddle). O tráfego
 * normal é de alguns pedidos por minuto, mais o monitor.
 *
 * 600/min (10/s) fica uma ordem de grandeza acima do uso real e ainda assim
 * corta uma enxurrada pela metade do primeiro segundo. Como o balde é único
 * (ver o cabeçalho), um número apertado aqui tiraria a escola do ar junto com
 * o atacante — a folga é deliberada.
 */
export const LIMITE_GLOBAL: LimiteDeRota = { max: 600, timeWindow: MINUTO };

/**
 * Rotas que o limitador NÃO pode tocar.
 *
 * ─── A ARMADILHA QUE ISTO EVITA ────────────────────────────────────────────
 *
 * O healthcheck do container bate em `/health` a cada 30 segundos
 * (`docker-compose.coolify.yml:184`). Um `/health` limitado devolveria 429, o
 * Docker leria "unhealthy" e **reiniciaria o container** — o limitador
 * derrubaria a aplicação que veio proteger, e o sintoma (container em laço)
 * não se parece nada com a causa.
 */
export const SEM_LIMITE: readonly string[] = ['/health', '/health/ready'];

/**
 * Tetos próprios, por custo real da rota — não por "parecer sensível".
 *
 * | rota | o que ela faz de caro |
 * |---|---|
 * | `POST /auth/sessao` | verifica o `id_token` contra o Google: chamada externa por pedido |
 * | `POST /sentencas/conferir` | lê as SEIS Sentenças no RM por SOAP |
 * | `POST /sentencas/restaurar` | **ESCREVE** Sentença no RM (`GlbConsSQLData.SaveRecord`) |
 *
 * `/auth/sair` e `/auth/sessoes/encerrar-outras` ficam no teto global: são
 * baratas e limitá-las só atrapalharia alguém tentando sair de uma sessão.
 *
 * Nota sobre `POST /auth/sessao`: aqui NÃO há força bruta de senha a conter —
 * o modo é `google-oidc` e não existe senha neste sistema. O que se contém é
 * custo: cada tentativa gasta uma verificação externa.
 */
const TETOS: ReadonlyArray<{ metodo: string; caminho: string; limite: LimiteDeRota }> = [
  { metodo: 'POST', caminho: '/auth/sessao', limite: { max: 30, timeWindow: MINUTO } },
  { metodo: 'POST', caminho: '/sentencas/conferir', limite: { max: 10, timeWindow: MINUTO } },
  { metodo: 'POST', caminho: '/sentencas/restaurar', limite: { max: 5, timeWindow: MINUTO } },
];

/**
 * O limite desta rota, ou `null` para "use o global".
 *
 * Decisão por método E caminho: `GET /sentencas` lista o que já foi conferido e
 * é barato; o `POST` de mesmo prefixo fala com o RM. Limitar por prefixo
 * puniria a leitura pelo custo da escrita.
 */
export function limiteParaRota(metodo: string, caminho: string): LimiteDeRota | null {
  if (SEM_LIMITE.includes(caminho)) return null;
  const achado = TETOS.find(
    (t) => t.metodo === metodo.toUpperCase() && t.caminho === caminho,
  );
  return achado?.limite ?? null;
}

/** `true` quando a rota deve ficar completamente fora do limitador. */
export function isentaDeLimite(caminho: string): boolean {
  return SEM_LIMITE.includes(caminho);
}


/**
 * Quantos saltos da frente a API confia.
 *
 * **1, e nunca `true`.** `true` faria o `req.ip` sair da entrada mais à
 * esquerda do `X-Forwarded-For`, que é controlada por quem chama — ver o
 * cabeçalho deste arquivo. `1` confia só no nginx, único par direto desta API.
 *
 * Mora aqui, e não embutido na chamada do `Fastify()`, para poder ser afirmado
 * em teste: a diferença entre `1` e `true` não produz erro nenhum em runtime,
 * só muda quem consegue mentir sobre a própria identidade.
 */
export const SALTOS_CONFIAVEIS = 1;
