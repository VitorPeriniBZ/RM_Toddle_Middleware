/**
 * Migra o `rm_code` do de-para `COURSE` de `IDTURMADISC` para
 * `CODPERLET:CODTURMA:CODDISC`.
 *
 *   npm run migrar:chave-course              # diagnostica, não escreve nada
 *   npm run migrar:chave-course -- --executar
 *
 * ─── POR QUE ESTA MIGRAÇÃO EXISTE ───────────────────────────────────────────
 *
 * `IDTURMADISC` é coluna identity do SQL Server, e toda cópia de produção sobre
 * o dev renumera. O desfecho ruim não é a turma sumir — é o número antigo passar
 * a pertencer a OUTRA turma-disciplina: o de-para aponta para a disciplina
 * errada, sem erro, e frequência e nota vão para a turma errada. Ver
 * `packages/domain/src/chaveCourse.ts`.
 *
 * ─── POR QUE ELA NÃO É UM .sql EM migrations/ ───────────────────────────────
 *
 * A correspondência `IDTURMADISC → (CODTURMA, CODDISC)` só existe **no RM**. Uma
 * migração SQL do Postgres não tem como consultá-la; teria de embutir um de-para
 * congelado, que envelhece no dia seguinte. Este script lê o RM na hora.
 *
 * ─── FAIL-CLOSED ────────────────────────────────────────────────────────────
 *
 * Se qualquer linha `COURSE` não puder ser traduzida, o script **não escreve
 * nada**. Migrar 180 de 185 deixaria a base com duas convenções ao mesmo tempo,
 * e aí `findByRmCode` erra em silêncio para as cinco restantes — que é
 * exatamente a classe de falha que a migração quer eliminar. Ou vai inteiro, ou
 * não vai, e o relatório nomeia quem impediu.
 *
 * É idempotente: linha que já está no formato novo é contada e ignorada, então
 * rodar duas vezes não quebra.
 */
import { idMappingRepository, pgPool, registrarEvento } from '@rm-toddle/db';
import { chaveCourse, fetchTeachersFromRm, pareceChaveLegada } from '@rm-toddle/domain';
import { tenantConfig } from '@rm-toddle/config';

const cfg = tenantConfig;

interface Traducao {
  id: string;
  de: string;
  para: string;
  codTurma: string;
  codDisc: string;
  estado: string;
}

async function main(): Promise<void> {
  const executar = process.argv.includes('--executar');
  const p = (linha = ''): void => console.log(linha);

  const periodoLetivo = cfg.rm.escopo.periodoLetivo;
  if (!periodoLetivo) {
    throw new Error(
      'RM_CODPERLET está vazio. O período letivo é parte da chave nova — sem ele a ' +
        'turma de 2027 colidiria com a de 2026. Preencha antes de migrar.',
    );
  }

  p('== migração da chave do de-para COURSE ==');
  p(`   de   IDTURMADISC`);
  p(`   para CODPERLET:CODTURMA:CODDISC  (período ${periodoLetivo})`);
  p(`   modo ${executar ? 'EXECUTAR' : 'diagnóstico (nada é escrito)'}`);
  p();

  // 1. O RM é quem sabe a correspondência. Lê antes de tocar no banco: se o RM
  //    estiver fora do ar, o script morre sem ter mexido em nada.
  const { turmaDiscs } = await fetchTeachersFromRm();
  const porId = new Map<string, { codTurma: string; codDisc: string }>();
  for (const td of turmaDiscs.values()) {
    porId.set(String(td.idTurmaDisc), { codTurma: td.codTurma, codDisc: td.codDisc });
  }
  p(`RM: ${porId.size} turma-disciplina lidas.`);

  // 2. Colisão na chave NOVA é bloqueio, não aviso. Se duas turma-disciplina do
  //    RM produzem a mesma chave, migrar uniria duas turmas no mesmo registro do
  //    Toddle — pior do que o problema original.
  const porChave = new Map<string, string[]>();
  for (const [id, { codTurma, codDisc }] of porId) {
    const chave = chaveCourse(periodoLetivo, codTurma, codDisc);
    porChave.set(chave, [...(porChave.get(chave) ?? []), id]);
  }
  const colisoes = [...porChave.entries()].filter(([, ids]) => ids.length > 1);
  if (colisoes.length > 0) {
    p(`ABORTA: ${colisoes.length} chave(s) nova(s) colidem no próprio RM.`);
    for (const [chave, ids] of colisoes.slice(0, 20)) p(`   ${chave}  <-  IDTURMADISC ${ids.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  // 3. As linhas atuais, dos DOIS estados. Arquivada também precisa migrar: é
  //    ela que permite desarquivar quem voltou ao escopo, e uma arquivada com a
  //    chave velha vira lixo invisível.
  const ativos = await idMappingRepository.listByType('COURSE', 'active');
  const arquivados = await idMappingRepository.listByType('COURSE', 'archived');
  const linhas = [
    ...ativos.map((m) => ({ ...m, estado: 'active' })),
    ...arquivados.map((m) => ({ ...m, estado: 'archived' })),
  ];
  p(`banco: ${ativos.length} COURSE ativos + ${arquivados.length} arquivados.`);
  p();

  const traduzir: Traducao[] = [];
  const jaMigrados: string[] = [];
  const semCorrespondencia: Array<{ rmCode: string; estado: string }> = [];

  for (const m of linhas) {
    if (!pareceChaveLegada(m.rmCode)) {
      jaMigrados.push(m.rmCode);
      continue;
    }
    const achado = porId.get(m.rmCode.trim());
    if (!achado) {
      semCorrespondencia.push({ rmCode: m.rmCode, estado: m.estado });
      continue;
    }
    traduzir.push({
      id: m.id,
      de: m.rmCode,
      para: chaveCourse(periodoLetivo, achado.codTurma, achado.codDisc),
      codTurma: achado.codTurma,
      codDisc: achado.codDisc,
      estado: m.estado,
    });
  }

  p(`já no formato novo : ${jaMigrados.length}`);
  p(`a traduzir         : ${traduzir.length}`);
  p(`SEM correspondência: ${semCorrespondencia.length}`);
  p();

  if (semCorrespondencia.length > 0) {
    p('IDTURMADISC que não existe mais no RM (ou está fora do escopo lido):');
    for (const s of semCorrespondencia.slice(0, 40)) p(`   ${s.rmCode}  (${s.estado})`);
    p();
    p('Nada foi escrito. Cada um destes é uma decisão humana:');
    p('  - turma que acabou  -> arquive o mapeamento antes de migrar;');
    p('  - fora do escopo    -> confira RM_CODFILIAL e RM_CODPERLET;');
    p('  - a base já foi copiada e os números mudaram -> use o CSV de');
    p('    docs/rm-sentencas/ para casar por (COD_TURMA, CODDISC).');
    process.exitCode = 1;
    return;
  }

  if (traduzir.length === 0) {
    p('Nada a fazer — o de-para já está na chave nova.');
    return;
  }

  for (const t of traduzir.slice(0, 15)) {
    p(`   ${t.de.padStart(6)}  ->  ${t.para}   (${t.estado})`);
  }
  if (traduzir.length > 15) p(`   … e mais ${traduzir.length - 15}.`);
  p();

  if (!executar) {
    p(`Diagnóstico só. Rode com --executar para aplicar as ${traduzir.length} traduções.`);
    return;
  }

  // 4. Uma transação para tudo, com a trilha dentro dela. Migração pela metade é
  //    o estado que esta migração existe para impedir.
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    for (const t of traduzir) {
      await client.query('UPDATE id_mapping SET rm_code = $1, updated_at = now() WHERE id = $2', [
        t.para,
        t.id,
      ]);
    }
    await registrarEvento(client, {
      ator: 'system/cli',
      acao: 'mapeamento.chave.migrada',
      entidade: 'id_mapping',
      entidadeId: 'COURSE',
      antes: { convencao: 'IDTURMADISC', linhas: traduzir.length },
      depois: { convencao: 'CODPERLET:CODTURMA:CODDISC', periodoLetivo, linhas: traduzir.length },
      motivo:
        'migrarChaveCourse: IDTURMADISC é coluna identity e a cópia de base renumera, fazendo ' +
        'o de-para apontar para a turma errada em silêncio.',
      resultado: 'ok',
    });
    await client.query('COMMIT');
    p(`OK: ${traduzir.length} linha(s) migrada(s), com evento na auditoria.`);
  } catch (e) {
    await client.query('ROLLBACK');
    p('ROLLBACK — nada foi alterado.');
    throw e;
  } finally {
    client.release();
  }
}

main()
  .then(() => pgPool.end())
  .catch(async (e) => {
    console.error(e);
    await pgPool.end();
    process.exit(1);
  });
