/**
 * Verifica o registro de execução (`operation`) contra um Postgres DE VERDADE.
 *
 *   npm run teste:run
 *
 * Não toca RM nem Toddle: só o banco local. Existe porque a parte arriscada
 * desse código é a aritmética jsonb dentro do UPDATE — `(resultado->>'x')::int + $n`
 * lendo o valor anterior da própria linha. Isso não dá para conferir lendo, e um
 * erro ali seria um contador silenciosamente errado, que é o tipo de bug que
 * ninguém percebe.
 *
 * Cobre: acumulação por lote, fechamento só no último, `failed` virando o estado,
 * preservação de `emEscopo` no merge, baseline da guarda ignorando run falhado,
 * run fechado não reabrindo, os cinco casos da guarda de desvio e a idempotência
 * da chave. Limpa o que criou (`tipo = 'teste.run'`).
 */
import {
  abrirRun, acumularLote, avaliarDesvio, fecharRunPorChave,
  ultimaContagemEmEscopo, pgPool,
} from '@rm-toddle/db';

const TIPO = 'teste.run';
const ok = (c: boolean, m: string) => console.log(`${c ? '  ok  ' : ' FALHA'} ${m}`);

async function main() {
  await pgPool.query('DELETE FROM operation WHERE tipo = $1', [TIPO]);

  // --- 1. run de 3 lotes: só o ultimo fecha -------------------------------
  const chave = 'run-teste-1';
  await abrirRun({
    tipo: TIPO, chave, configVersion: 'v1',
    payload: { lotesEsperados: 3 },
    resultadoInicial: { emEscopo: 255, lotesConcluidos: 0 },
  });
  const r1 = await acumularLote(chave, { created: 1, updated: 49, unarchived: 0, failed: 0 });
  ok(r1 === null, 'lote 1 de 3 nao fecha o run');
  const r2 = await acumularLote(chave, { created: 2, updated: 48, unarchived: 1, failed: 0 });
  ok(r2 === null, 'lote 2 de 3 nao fecha o run');
  const r3 = await acumularLote(chave, { created: 0, updated: 50, unarchived: 0, failed: 0 });
  ok(r3?.completo === true, 'lote 3 de 3 FECHA o run');
  ok(r3?.estado === 'succeeded', `estado = succeeded (veio ${r3?.estado})`);
  const res = r3?.resultado as Record<string, number>;
  ok(res?.created === 3, `created somado = 3 (veio ${res?.created})`);
  ok(res?.updated === 147, `updated somado = 147 (veio ${res?.updated})`);
  ok(res?.unarchived === 1, `unarchived somado = 1 (veio ${res?.unarchived})`);
  ok(res?.emEscopo === 255, `emEscopo preservado pelo merge = 255 (veio ${res?.emEscopo})`);

  const { rows: e1 } = await pgPool.query('SELECT estado FROM operation WHERE idempotency_key=$1',[chave]);
  ok(e1[0]?.estado === 'succeeded', 'estado persistido no banco');

  // --- 2. lote com falha marca o run como failed --------------------------
  const chave2 = 'run-teste-2';
  await abrirRun({ tipo: TIPO, chave: chave2, configVersion: 'v1',
    payload: { lotesEsperados: 1 }, resultadoInicial: { emEscopo: 10, lotesConcluidos: 0 } });
  const r4 = await acumularLote(chave2, { created: 0, updated: 9, unarchived: 0, failed: 1 });
  ok(r4?.estado === 'failed', `run com failed>0 vira failed (veio ${r4?.estado})`);

  // --- 3. baseline da guarda ignora run FAILED ----------------------------
  const base = await ultimaContagemEmEscopo(TIPO);
  ok(base === 255, `baseline = 255 do run succeeded, ignorando o failed de 10 (veio ${base})`);

  // --- 4. acumular em run ja fechado nao faz nada -------------------------
  const r5 = await acumularLote(chave, { created: 99, updated: 99, unarchived: 0, failed: 0 });
  ok(r5 === null, 'acumular em run fechado nao reabre nem soma');

  // --- 5. a guarda de desvio ---------------------------------------------
  ok(avaliarDesvio(255, 257).aborta === false, 'desvio de 0,8% passa');
  ok(avaliarDesvio(255, 300).aborta === true, 'desvio de 17,6% aborta');
  ok(avaliarDesvio(255, 0).aborta === true, 'queda para zero aborta');
  ok(avaliarDesvio(null, 255).aborta === false, 'sem historico nao opina');
  ok(avaliarDesvio(0, 255).aborta === false, 'anterior zero nao opina');

  // --- 6. idempotencia da chave -----------------------------------------
  await abrirRun({ tipo: TIPO, chave, configVersion: 'v2', payload: { lotesEsperados: 3 } });
  const { rows: n } = await pgPool.query('SELECT count(*)::int c FROM operation WHERE idempotency_key=$1',[chave]);
  ok(n[0].c === 1, `reabrir a mesma chave nao duplica linha (veio ${n[0].c})`);

  await pgPool.query('DELETE FROM operation WHERE tipo = $1', [TIPO]);
  await pgPool.end();
}
main().catch((e) => { console.error('ERRO', e); process.exit(1); });
