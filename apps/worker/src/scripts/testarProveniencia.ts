/**
 * Verifica o repositório de proveniência contra um Postgres DE VERDADE.
 *
 *   npm run teste:proveniencia
 *
 * Não toca RM nem Toddle. A parte que precisa de banco real é o índice único
 * `coalesce(campo, '')`: em Postgres, `NULL` não participa de UNIQUE, então sem
 * o `coalesce` duas linhas com `campo` nulo para a mesma chave natural
 * conviveriam — e a pergunta "isto é nosso?" passaria a ter duas respostas. Isso
 * não se confere lendo o SQL.
 */
import { abrirRun, carregarProveniencia, chaveDoMapa, contarProveniencia,
         escritasDoRun, pgPool, registrarEscrita } from '@rm-toddle/db';
import { hashValor } from '@rm-toddle/domain';
let f = 0;
const ok = (c: boolean, m: string) => { if (!c) f++; console.log(`  ${c?'ok  ':'FALHA'} ${m}`); };
async function main() {
  await pgPool.query("delete from rm_write_provenance");
  await pgPool.query("delete from operation where tipo='teste.prov'");
  const runId = await abrirRun({tipo:'teste.prov',chave:'prov-1',configVersion:'v',payload:{}});
  ok(!!runId, 'run aberto para amarrar as escritas');

  const k1='1|5791|1240|202600009|2026-03-02';
  await registrarEscrita({entidade:'FREQUENCIA',chaveNatural:k1,payloadHash:hashValor('A'),operationId:runId});
  let m = await carregarProveniencia('FREQUENCIA',[k1]);
  ok(m.get(chaveDoMapa(k1))?.payloadHash === hashValor('A'), 'linha (campo NULL) grava e carrega');

  // idempotencia: mesma chave nao duplica, atualiza o hash
  await registrarEscrita({entidade:'FREQUENCIA',chaveNatural:k1,payloadHash:hashValor('P'),operationId:runId});
  const { rows: n1 } = await pgPool.query("select count(*)::int c from rm_write_provenance where chave_natural=$1",[k1]);
  ok(n1[0].c === 1, `reescrever a mesma chave nao duplica (veio ${n1[0].c})`);
  m = await carregarProveniencia('FREQUENCIA',[k1]);
  ok(m.get(chaveDoMapa(k1))?.payloadHash === hashValor('P'), 'hash atualizado no lugar');

  // por CAMPO: mesma chave natural, campos diferentes, convivem
  const k2='1|1240|281980';
  await registrarEscrita({entidade:'PLANO_AULA',chaveNatural:k2,campo:'CONTEUDOEFETIVO',payloadHash:hashValor('Frações'),operationId:runId});
  await registrarEscrita({entidade:'PLANO_AULA',chaveNatural:k2,campo:'LICAOCASA',payloadHash:hashValor('pág. 42'),operationId:runId});
  m = await carregarProveniencia('PLANO_AULA',[k2]);
  ok(m.size === 2, `dois campos da mesma chave convivem (veio ${m.size})`);
  ok(m.get(chaveDoMapa(k2,'CONTEUDOEFETIVO'))?.payloadHash === hashValor('Frações'), 'campo 1 correto');
  ok(m.get(chaveDoMapa(k2,'LICAOCASA'))?.payloadHash === hashValor('pág. 42'), 'campo 2 correto');

  // entidades diferentes nao se misturam
  const mf = await carregarProveniencia('FREQUENCIA',[k2]);
  ok(mf.size === 0, 'chave de PLANO_AULA nao aparece em FREQUENCIA');

  // lote
  const chaves = Array.from({length:200},(_,i)=>`1|h${i}|td|ra|2026-03-02`);
  for (const c of chaves.slice(0,50)) await registrarEscrita({entidade:'FREQUENCIA',chaveNatural:c,payloadHash:hashValor('A'),operationId:runId});
  const lote = await carregarProveniencia('FREQUENCIA',chaves);
  ok(lote.size === 50, `lote de 200 chaves devolve as 50 conhecidas (veio ${lote.size})`);

  // lista de reversao
  const doRun = await escritasDoRun(runId!);
  ok(doRun.length === 53, `escritasDoRun devolve tudo que o run escreveu (veio ${doRun.length})`);

  const cont = await contarProveniencia();
  ok(cont.FREQUENCIA === 51 && cont.PLANO_AULA === 2, `contagem por entidade: ${JSON.stringify(cont)}`);

  // entidade invalida e recusada pelo CHECK
  let recusou = false;
  try { await registrarEscrita({entidade:'INVENTADA' as never,chaveNatural:'x',payloadHash:'h'}); }
  catch { recusou = true; }
  ok(recusou, 'entidade fora do CHECK e recusada pelo banco');

  await pgPool.query("delete from rm_write_provenance");
  await pgPool.query("delete from operation where tipo='teste.prov'");
  await pgPool.end();
  console.log(f===0 ? '\n  TODOS OS CASOS PASSARAM\n' : `\n  ${f} FALHA(S)\n`);
  process.exit(f===0?0:1);
}
main().catch((e)=>{console.error('ERRO',e);process.exit(1);});
