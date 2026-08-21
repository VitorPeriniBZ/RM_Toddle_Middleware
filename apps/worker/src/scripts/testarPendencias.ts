import {
  abrirRun,
  listarPendencias,
  pgPool,
  registrarPendencia,
  resolverPendencia,
  resumoPendencias,
} from '@rm-toddle/db';
import { hashValor } from '@rm-toddle/domain';

/**
 * Verifica a fila de pendências contra um Postgres DE VERDADE.
 *
 *   npm run teste:pendencias
 *
 * ─── O QUE SÓ SE CONFERE COM BANCO REAL ─────────────────────────────────────
 *
 * A regra de reabertura vive num `ON CONFLICT ... DO UPDATE` com quatro `CASE`
 * comparando `hash_desejado`. Isso não se confere lendo: ou se executa contra
 * Postgres, ou não se sabe.
 *
 * E o que ela decide é se a fila serve para algo. Reabrir toda passada faria a
 * pendência resolvida voltar em 6 horas (o cron roda 4x ao dia) e a fila viraria
 * ruído permanente — mesmo destino do alerta que grita por nada. Nunca reabrir
 * faria uma decisão antiga valer para um valor novo, que ninguém analisou.
 */

const K = '1|5791|1240|202600009|2026-03-02';
let f = 0;
const ok = (c: boolean, m: string): void => {
  if (!c) f += 1;
  console.log(`  ${c ? 'ok  ' : 'FALHA'} ${m}`);
};

async function limpar(): Promise<void> {
  await pgPool.query('delete from write_pendency');
  await pgPool.query("delete from operation where tipo = 'teste.pend'");
}

async function main(): Promise<void> {
  await limpar();
  const runId = await abrirRun({
    tipo: 'teste.pend',
    chave: 'pend-1',
    configVersion: 'v',
    payload: {},
  });

  const base = {
    entidade: 'FREQUENCIA' as const,
    chaveNatural: K,
    veredito: 'CONFLITO_HUMANO' as const,
    porque: 'o RM tem valor diferente e a autoria não é da integração',
    valorNoRm: 'P',
    origemId: 'tod-1',
    operationId: runId,
  };

  console.log('\n── primeira detecção ─────────────────────────────────────────');
  const aberta1 = await registrarPendencia({ ...base, valorDesejado: 'A', hashDesejado: hashValor('A') });
  ok(aberta1, 'nasce aberta');
  let lista = await listarPendencias({ estado: 'aberta' });
  ok(lista.length === 1, `uma pendência na fila (veio ${lista.length})`);
  ok(lista[0].vezesVista === 1, `vezes_vista = 1 (veio ${lista[0].vezesVista})`);
  ok(lista[0].valorDesejado === 'A' && lista[0].valorNoRm === 'P', 'os dois lados do conflito');

  console.log('\n── redetecção do MESMO conflito não duplica ──────────────────');
  await registrarPendencia({ ...base, valorDesejado: 'A', hashDesejado: hashValor('A') });
  await registrarPendencia({ ...base, valorDesejado: 'A', hashDesejado: hashValor('A') });
  const { rows: n } = await pgPool.query<{ c: number }>(
    'select count(*)::int c from write_pendency',
  );
  ok(n[0].c === 1, `continua UMA linha depois de 3 detecções (veio ${n[0].c})`);
  lista = await listarPendencias();
  ok(lista[0].vezesVista === 3, `vezes_vista = 3 (veio ${lista[0].vezesVista})`);

  console.log('\n── resolver ──────────────────────────────────────────────────');
  const resolveu = await resolverPendencia(lista[0].id, 'vitor', 'corrigi no Toddle');
  ok(resolveu, 'resolve');
  lista = await listarPendencias({ estado: 'resolvida' });
  ok(lista.length === 1 && lista[0].resolucao === 'corrigi no Toddle', 'resolução gravada');
  ok((await resumoPendencias()).abertas === 0, 'sai da contagem de abertas');
  ok(
    !(await resolverPendencia(lista[0].id, 'vitor', 'de novo')),
    'resolver duas vezes não faz efeito',
  );

  console.log('\n── redetecção com MESMO valor NÃO reabre ─────────────────────');
  const abertaA = await registrarPendencia({
    ...base,
    valorDesejado: 'A',
    hashDesejado: hashValor('A'),
  });
  ok(!abertaA, 'segue resolvida — a decisão de quem resolveu continua valendo');
  lista = await listarPendencias();
  ok(lista[0].estado === 'resolvida', `estado = resolvida (veio ${lista[0].estado})`);
  ok(lista[0].vezesVista === 4, `mas vezes_vista avançou para 4 (veio ${lista[0].vezesVista})`);
  ok(lista[0].resolucao === 'corrigi no Toddle', 'a resolução foi preservada');

  console.log('\n── redetecção com valor DIFERENTE reabre ─────────────────────');
  const abertaB = await registrarPendencia({
    ...base,
    valorDesejado: 'FJ',
    hashDesejado: hashValor('FJ'),
  });
  ok(abertaB, 'reabre: é outro conflito sobre a mesma aula');
  lista = await listarPendencias();
  ok(lista[0].estado === 'aberta', `estado = aberta (veio ${lista[0].estado})`);
  ok(lista[0].resolucao === undefined, 'a resolução anterior foi LIMPA — era sobre outro valor');
  ok(lista[0].valorDesejado === 'FJ', 'o valor desejado foi atualizado');

  console.log('\n── espaço em branco não conta como valor novo ────────────────');
  await resolverPendencia(lista[0].id, 'vitor', 'ok');
  const abertaC = await registrarPendencia({
    ...base,
    valorDesejado: ' FJ ',
    hashDesejado: hashValor(' FJ '),
  });
  ok(!abertaC, '" FJ " não reabre uma pendência resolvida sobre "FJ"');

  console.log('\n── campo NULL e campo preenchido convivem ────────────────────');
  await registrarPendencia({
    entidade: 'PLANO_AULA',
    chaveNatural: '1|1240|281980',
    campo: 'CONTEUDOEFETIVO',
    veredito: 'EDITADO_POR_FORA',
    porque: 'alguém editou no RM depois de nós',
    valorDesejado: 'Frações',
    valorNoRm: 'Frações e decimais',
    hashDesejado: hashValor('Frações'),
    operationId: runId,
  });
  await registrarPendencia({
    entidade: 'PLANO_AULA',
    chaveNatural: '1|1240|281980',
    veredito: 'REMOCAO_PEDE_HUMANO',
    porque: 'saiu do Toddle mas existe no RM',
    hashDesejado: hashValor(null),
    operationId: runId,
  });
  const { rows: n2 } = await pgPool.query<{ c: number }>(
    "select count(*)::int c from write_pendency where entidade='PLANO_AULA'",
  );
  ok(n2[0].c === 2, `a mesma chave com campo e sem campo são duas pendências (veio ${n2[0].c})`);

  console.log('\n── filtros e resumo ──────────────────────────────────────────');
  ok((await listarPendencias({ entidade: 'PLANO_AULA' })).length === 2, 'filtro por entidade');
  ok(
    (await listarPendencias({ veredito: 'EDITADO_POR_FORA' })).length === 1,
    'filtro por veredito',
  );
  const r = await resumoPendencias();
  ok(r.abertas === 2, `abertas = 2 (veio ${r.abertas})`);
  ok(
    r.porEntidade.PLANO_AULA === 2 && r.porVeredito.EDITADO_POR_FORA === 1,
    `resumo por entidade e veredito: ${JSON.stringify(r)}`,
  );
  ok(r.maisAntigaDias === 0, `idade da mais antiga em dias = 0 (veio ${r.maisAntigaDias})`);

  console.log('\n── o CHECK do banco protege a integridade ────────────────────');
  let recusou = false;
  try {
    await pgPool.query(
      `insert into write_pendency (tenant_id, entidade, chave_natural, veredito, porque, hash_desejado, estado)
       select tenant_id, 'FREQUENCIA', 'k-solta', 'CONFLITO_HUMANO', 'x', 'h', 'resolvida'
         from write_pendency limit 1`,
    );
  } catch {
    recusou = true;
  }
  ok(recusou, "'resolvida' sem resolvido_por/em é recusada pelo CHECK");

  recusou = false;
  try {
    await pgPool.query(
      `insert into write_pendency (tenant_id, entidade, chave_natural, veredito, porque, hash_desejado)
       select tenant_id, 'FREQUENCIA', 'k2', 'VEREDITO_INVENTADO', 'x', 'h'
         from write_pendency limit 1`,
    );
  } catch {
    recusou = true;
  }
  ok(recusou, 'veredito fora do CHECK é recusado');

  await limpar();
  await pgPool.end();
  console.log(f === 0 ? '\n  TODOS OS CASOS PASSARAM\n' : `\n  ${f} FALHA(S)\n`);
  process.exit(f === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('ERRO', e);
  process.exit(1);
});
