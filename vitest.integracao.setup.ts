import { tenantConfig } from '@rm-toddle/config';
import { pgPool } from '@rm-toddle/db';

/**
 * Garante que o tenant DE TESTE existe antes de qualquer `.itest.ts` rodar.
 *
 * ─── POR QUE OS TESTES PRECISAM DE UM TENANT SÓ DELES ───────────────────────
 *
 * Em 24/08/2026 a suíte de integração APAGOU dado real. `rm_write_provenance`
 * tinha as 24 linhas da primeira escrita de frequência no RM; o `limpar` de
 * `provenanceRepository.itest.ts` fazia `delete from rm_write_provenance`, sem
 * cláusula, e levou tudo. Junto foram as 2 pendências abertas.
 *
 * Não é dado qualquer. Proveniência é a resposta para "esta linha no ERP do
 * cliente é nossa ou de um professor?". Sem ela, a passada seguinte trata o que
 * nós mesmos escrevemos como trabalho humano — ou, se alguém interpretar a
 * ausência como autorização, sobrescreve lançamento de professor em silêncio.
 *
 * ─── E POR QUE PREFIXO NÃO BASTARIA ────────────────────────────────────────
 *
 * A correção óbvia seria marcar as chaves do teste com um prefixo e apagar só
 * elas. Não resolve: os testes afirmam contagens ABSOLUTAS
 * (`contarProveniencia()` igual a `{FREQUENCIA: 51}`, `resumoPendencias().abertas`
 * igual a 2), e essas consultas agregam POR TENANT. Qualquer linha real no mesmo
 * tenant quebraria a asserção — o teste continuaria assumindo que é dono da
 * tabela, só que falhando em vez de destruindo.
 *
 * Com tenant próprio o isolamento é estrutural. E é o mesmo eixo que a
 * arquitetura já usa para separar escolas (deploy-por-tenant), então o teste
 * passa a exercitar a coluna que existe exatamente para isso.
 *
 * O `TENANT_SLUG` vem de `vitest.workspace.ts`. `dotenv` não sobrescreve o que já
 * está no ambiente, então o `.env` da máquina não vaza para cá.
 */

const ESPERADO = 'integracao-teste';

/**
 * Chave do lock consultivo do Postgres. Número arbitrário e fixo; o que importa
 * é ser o MESMO em todo processo que rode esta suíte.
 */
const TRAVA = 828_140_914;

export default async function setup(): Promise<() => Promise<void>> {
  if (tenantConfig.slug !== ESPERADO) {
    throw new Error(
      `Os testes de integração precisam rodar sob TENANT_SLUG="${ESPERADO}", e este ` +
        `processo resolveu "${tenantConfig.slug}". Rodar a suíte contra o tenant de uma ` +
        'escola de verdade APAGA proveniência e pendências reais — já aconteceu. ' +
        'Confira o `env` do projeto `integration` em vitest.workspace.ts.',
    );
  }

  /*
   * ─── DUAS SUÍTES AO MESMO TEMPO NÃO É "FALHA INTERMITENTE" ────────────────
   *
   * `fileParallelism: false` ordena os arquivos DENTRO de um processo, e nada
   * mais. Dois `vitest` simultâneos contra o mesmo banco — um subagente e eu,
   * em 12/09/2026 — dividem o tenant da suíte, e o `limpar` de um apaga a linha
   * que o outro acabou de inserir. O sintoma é um teste que falha uma vez e
   * passa dez, e tempo gasto procurando no lugar errado: foram dez passagens
   * seguidas atrás de uma falha que não estava no código.
   *
   * O lock consultivo faz o segundo processo ESPERAR em vez de atropelar.
   *
   * A conexão é DEDICADA, e isso não é zelo: o lock de sessão pertence à
   * conexão que o tomou. Tirado por `pgPool.query`, ele ficaria presente numa
   * conexão devolvida ao pool, e o unlock cairia provavelmente em OUTRA — que
   * não o detém. O Postgres responde `false` a esse unlock, sem erro; a trava
   * sobreviveria à suíte e o próximo processo esperaria para sempre.
   */
  const trava = await pgPool.connect();
  await trava.query('SELECT pg_advisory_lock($1)', [TRAVA]);

  await pgPool.query(
    `INSERT INTO tenant (slug, nome, status)
     VALUES ($1, 'Tenant da suíte de integração', 'active')
     ON CONFLICT (slug) DO UPDATE SET status = 'active'`,
    [ESPERADO],
  );

  // `release(true)` destrói a conexão em vez de devolvê-la ao pool — e é o
  // encerramento dela que o Postgres usa para soltar o lock, inclusive quando a
  // suíte morre de Ctrl+C sem chegar aqui.
  return async () => {
    await trava.query('SELECT pg_advisory_unlock($1)', [TRAVA]).catch(() => undefined);
    trava.release(true);
  };
}
