import { env, tenantConfig } from '@rm-toddle/config';
import {
  abrirRun,
  decidirOperacao,
  estaAprovado,
  identidadeDeCli,
  operacoesPendentes,
  pedirAprovacao,
  pgPool,
} from '@rm-toddle/db';
import { avaliarVolume, type LimitesDeVolume } from '@rm-toddle/domain';

/**
 * Verifica o teto de volume e o gate de aprovação.
 *
 *   npm run teste:teto
 *
 * O teto é aritmética pura e roda sem nada. O gate precisa de Postgres real,
 * porque a decisão grava em `approval` E move `operation.estado` numa transação —
 * e a recusa de auto-aprovação depende de um `SELECT ... FOR UPDATE`.
 *
 * ─── POR QUE ESTE TESTE É O MAIS IMPORTANTE DOS QUATRO ──────────────────────
 *
 * As guardas por registro são cegas para "quantas?". Um JOIN errado no de-para
 * virando produto cartesiano gera milhares de decisões individualmente CORRETAS —
 * cada linha realmente não está no RM. Este teto é o único ponto do sistema que
 * olha o agregado, e portanto o único que pega essa classe de defeito.
 */

const LIM: LimitesDeVolume = {
  tetoAbsoluto: 5_000,
  desvioMaxPct: 50,
  tetoEscopoPct: 30,
  pisoSemAprovacao: 50,
};

let f = 0;
const ok = (c: boolean, m: string): void => {
  if (!c) f += 1;
  console.log(`  ${c ? 'ok  ' : 'FALHA'} ${m}`);
};
const vd = (
  nome: string,
  esperado: string,
  aEscrever: number,
  emEscopo: number,
  historico: number | null,
  limites = LIM,
): void => {
  const r = avaliarVolume({ aEscrever, emEscopo, historico }, limites);
  ok(r.veredito === esperado, `${nome} → ${r.veredito}`);
  if (r.veredito !== esperado) console.log(`         esperava ${esperado}: ${r.motivos.join(' | ')}`);
};

/**
 * Limpa o que o teste criou.
 *
 * A ordem é obrigatória: `approval.operation_id` é `ON DELETE RESTRICT`, então a
 * aprovação sai antes da operação. O RESTRICT é proposital — aprovação órfã seria
 * registro de decisão sem a decisão. A primeira versão deste teste apagou na
 * ordem errada e o banco recusou, que é o comportamento certo.
 */
async function limpar(): Promise<void> {
  await pgPool.query(
    `delete from approval where operation_id in
       (select id from operation where tipo like 'teste.gate%')`,
  );
  await pgPool.query("delete from operation where tipo like 'teste.gate%'");
  await pgPool.query("delete from user_identity where provider = 'cli'");
}

async function main(): Promise<void> {
  console.log('\n══ TETO DE VOLUME (aritmética pura) ═══════════════════════════');

  console.log('\n── nada a escrever nunca trava o cron ────────────────────────');
  vd('0 linhas, sem histórico', 'AUTORIZADO', 0, 1000, null);
  vd('0 linhas, com histórico', 'AUTORIZADO', 0, 1000, 200);

  console.log('\n── a primeira escrita da vida passa por humano ───────────────');
  vd('10 linhas, sem histórico', 'PRECISA_APROVACAO', 10, 1000, null);
  vd('1 linha, sem histórico', 'PRECISA_APROVACAO', 1, 1000, null);
  ok(
    avaliarVolume({ aEscrever: 1, emEscopo: 1000, historico: null }, LIM).motivos.some((m) =>
      m.includes('primeira vez'),
    ),
    'e o motivo diz por quê',
  );

  console.log('\n── regime normal ─────────────────────────────────────────────');
  vd('200 de 2000, histórico 200', 'AUTORIZADO', 200, 2000, 200);
  vd('280 de 2000, histórico 200 (+40%)', 'AUTORIZADO', 280, 2000, 200);

  console.log('\n── desvio sobre o histórico ──────────────────────────────────');
  vd('400 de 2000, histórico 200 (+100%)', 'PRECISA_APROVACAO', 400, 2000, 200);
  vd('3000 de 20000, histórico 200', 'PRECISA_APROVACAO', 3000, 20000, 200);

  console.log('\n── percentual do escopo, mesmo sem desvio ────────────────────');
  vd('800 de 1000 (80%), histórico 800', 'PRECISA_APROVACAO', 800, 1000, 800);
  ok(
    avaliarVolume({ aEscrever: 800, emEscopo: 1000, historico: 800 }, LIM).motivos.some((m) =>
      m.includes('% do escopo'),
    ),
    'o motivo é o escopo, não o desvio',
  );

  console.log('\n── os dois gatilhos ao mesmo tempo acumulam motivos ──────────');
  const dois = avaliarVolume({ aEscrever: 900, emEscopo: 1000, historico: 100 }, LIM);
  ok(dois.veredito === 'PRECISA_APROVACAO', 'precisa aprovação');
  ok(dois.motivos.length === 2, `dois motivos, não um (veio ${dois.motivos.length})`);

  console.log('\n── o piso protege contra ruído percentual ────────────────────');
  vd('6 de 1000, histórico 2 (+200%)', 'AUTORIZADO', 6, 1000, 2);
  vd('50 de 60 (83% do escopo), histórico 50', 'AUTORIZADO', 50, 60, 50);
  vd('51 de 60, histórico 50', 'PRECISA_APROVACAO', 51, 60, 50);

  console.log('\n── teto absoluto: nem aprovação resolve ──────────────────────');
  vd('5001 linhas', 'RECUSADO', 5001, 100000, 5000);
  vd('50000 linhas', 'RECUSADO', 50000, 100000, 40000);
  vd('5000 linhas (no limite)', 'AUTORIZADO', 5000, 100000, 5000);

  console.log('\n── divisões por zero não explodem ───────────────────────────');
  const semEscopo = avaliarVolume({ aEscrever: 10, emEscopo: 0, historico: 10 }, LIM);
  ok(semEscopo.pctDoEscopo === null, 'escopo 0 → pctDoEscopo null, sem NaN');
  const histZero = avaliarVolume({ aEscrever: 10, emEscopo: 100, historico: 0 }, LIM);
  ok(histZero.pctSobreHistorico === null, 'histórico 0 → pctSobreHistorico null');
  ok(histZero.veredito === 'AUTORIZADO', 'histórico 0 com 10 linhas não trava (abaixo do piso)');

  console.log('\n── os limites do .env são os que valem ───────────────────────');
  ok(env.WRITE_TETO_ABSOLUTO === 5_000, `WRITE_TETO_ABSOLUTO = ${env.WRITE_TETO_ABSOLUTO}`);
  ok(env.WRITE_DESVIO_MAX_PCT === 50, `WRITE_DESVIO_MAX_PCT = ${env.WRITE_DESVIO_MAX_PCT}`);
  ok(env.WRITE_TETO_ESCOPO_PCT === 30, `WRITE_TETO_ESCOPO_PCT = ${env.WRITE_TETO_ESCOPO_PCT}`);
  ok(env.WRITE_PISO_SEM_APROVACAO === 50, `WRITE_PISO_SEM_APROVACAO = ${env.WRITE_PISO_SEM_APROVACAO}`);

  console.log('\n══ GATE DE APROVAÇÃO (Postgres real) ══════════════════════════');
  await limpar();

  console.log('\n── run de cron: pede, aparece na fila, é aprovado ────────────');
  const chave = 'gate-cron-1';
  await abrirRun({ tipo: 'teste.gate', chave, configVersion: 'v', payload: {} });
  ok(!(await estaAprovado(chave)), 'não nasce aprovado');
  await pedirAprovacao({
    chave,
    tipo: 'teste.gate',
    payload: { aEscrever: 3000, motivos: ['+1400% sobre o histórico'] },
  });
  let fila = await operacoesPendentes();
  ok(fila.length === 1, `uma operação esperando decisão (veio ${fila.length})`);
  ok(fila[0].payload.aEscrever === 3000, 'o plano vai no payload, para quem aprova ler');
  ok(fila[0].criadoPor === undefined, 'run de cron não tem proponente');

  const d = await decidirOperacao(fila[0].id, 'vitor', 'approved', 'conferi com a coordenação');
  ok(d.ok, 'aprova');
  ok(await estaAprovado(chave), 'o writer passa a ver como aprovado');
  ok((await operacoesPendentes()).length === 0, 'sai da fila');

  console.log('\n── a decisão fica registrada com nome e motivo ───────────────');
  const { rows: ap } = await pgPool.query<{ decisao: string; motivo: string; subject: string }>(
    `select a.decisao, a.motivo, u.subject
       from approval a join user_identity u on u.id = a.approver_id
       join operation o on o.id = a.operation_id
      where o.idempotency_key = $1`,
    [chave],
  );
  ok(ap.length === 1, 'uma linha em approval');
  ok(
    ap[0].decisao === 'approved' && ap[0].subject === 'vitor' && !!ap[0].motivo,
    `quem, o quê e por quê: ${JSON.stringify(ap[0])}`,
  );

  console.log('\n── recusar ───────────────────────────────────────────────────');
  const chave2 = 'gate-cron-2';
  await pedirAprovacao({ chave: chave2, tipo: 'teste.gate', payload: { aEscrever: 9 } });
  const f2 = (await operacoesPendentes())[0];
  ok((await decidirOperacao(f2.id, 'vitor', 'rejected', 'era bug do de-para')).ok, 'recusa');
  ok(!(await estaAprovado(chave2)), 'recusado NÃO libera a escrita');

  console.log('\n── decidir duas vezes não reabre ─────────────────────────────');
  const r2 = await decidirOperacao(f2.id, 'vitor', 'approved', 'mudei de ideia');
  ok(!r2.ok, `recusa segunda decisão: ${r2.ok ? '' : r2.erro}`);

  console.log('\n── segregação de funções, onde ela significa algo ────────────');
  const proponente = await identidadeDeCli('ana');
  const chave3 = 'gate-proposto-1';
  await pgPool.query(
    `insert into operation (tenant_id, tipo, estado, payload, idempotency_key, criado_por)
     select t.id, 'teste.gate', 'needs_review', '{}'::jsonb, $1, $2 from tenant t where t.slug = $3`,
    [chave3, proponente, tenantConfig.slug],
  );
  const op3 = (await operacoesPendentes()).find((o) => o.chave === chave3)!;
  const auto = await decidirOperacao(op3.id, 'ana', 'approved', 'eu mesma');
  ok(!auto.ok, 'quem propôs NÃO aprova a própria operação');
  ok(
    !auto.ok && auto.erro.includes('não pode aprová-la'),
    'e a mensagem explica, inclusive que run agendado é diferente',
  );
  const outro = await decidirOperacao(op3.id, 'vitor', 'approved', 'revisei o plano da ana');
  ok(outro.ok, 'outra pessoa aprova');

  console.log('\n── operação inexistente e fail-closed ───────────────────────');
  const fantasma = await decidirOperacao(
    '00000000-0000-0000-0000-000000000000',
    'vitor',
    'approved',
    'x',
  );
  ok(!fantasma.ok, 'operação inexistente é recusada');
  ok(!(await estaAprovado('chave-que-nao-existe')), 'chave inexistente não conta como aprovada');

  await limpar();
  await pgPool.end();
  console.log(f === 0 ? '\n  TODOS OS CASOS PASSARAM\n' : `\n  ${f} FALHA(S)\n`);
  process.exit(f === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('ERRO', e);
  process.exit(1);
});
