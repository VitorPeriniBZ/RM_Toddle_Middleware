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

export default async function setup(): Promise<void> {
  if (tenantConfig.slug !== ESPERADO) {
    throw new Error(
      `Os testes de integração precisam rodar sob TENANT_SLUG="${ESPERADO}", e este ` +
        `processo resolveu "${tenantConfig.slug}". Rodar a suíte contra o tenant de uma ` +
        'escola de verdade APAGA proveniência e pendências reais — já aconteceu. ' +
        'Confira o `env` do projeto `integration` em vitest.workspace.ts.',
    );
  }

  await pgPool.query(
    `INSERT INTO tenant (slug, nome, status)
     VALUES ($1, 'Tenant da suíte de integração', 'active')
     ON CONFLICT (slug) DO UPDATE SET status = 'active'`,
    [ESPERADO],
  );
}
