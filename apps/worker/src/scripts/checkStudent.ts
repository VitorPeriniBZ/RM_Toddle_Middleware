import { env } from '@rm-toddle/config';
import { toddleClient } from '@rm-toddle/integrations';
import { fetchStudentsFromRm } from '@rm-toddle/domain';
import { idMappingRepository } from '@rm-toddle/db';
import { toSyncItem, toCreatePayload } from '@rm-toddle/domain';
import { buildSourceId } from '@rm-toddle/domain';
import { resolveYearGroupId } from '@rm-toddle/domain';
import { pgPool } from '@rm-toddle/db';

/**
 * Diagnóstico ponta-a-ponta de UM aluno, sem escrever em lugar nenhum.
 * Responde "por que o aluno X do RM (não) chegou no Toddle?" checando, em ordem,
 * os quatro pontos onde ele pode se perder:
 *
 *   1. A Sentença do RM devolve esse RA?           (se não: filtro da Sentença)
 *   2. O middleware consegue transformá-lo?        (se não: falta RA ou nome)
 *   3. A turma tem yearGroupId mapeado?            (se não: rode seed:yeargroups)
 *   4. Ele já existe no Toddle / no id_mapping?    (define create vs update)
 *
 * Uso: npm run check:student -- <RA>
 */
async function main(): Promise<void> {
  const ra = process.argv[2]?.trim();
  if (!ra) {
    console.log('Uso: npm run check:student -- <RA>   (ex.: npm run check:student -- 202600022)');
    await pgPool.end();
    return;
  }

  const sourceId = buildSourceId(ra);
  console.log(`\nRA ${ra}  ->  sourceId ${sourceId}\n${'='.repeat(50)}`);

  // --- 1. A Sentença do RM devolve esse RA? ---
  const { contexts, enrichmentByCode } = await fetchStudentsFromRm();
  const ctx = contexts.find((c) => String(c.StudentCode).trim() === ra);

  if (!ctx) {
    console.log(`\n1. RM ......... NAO ENCONTRADO na Sentenca ${env.RM_SENTENCA_STUDENTS}`);
    console.log(`   A Sentenca devolveu ${contexts.length} aluno(s) e este RA nao esta entre eles.`);
    console.log('   Causa provavel: o filtro da Sentenca (turma, status de matricula ou');
    console.log('   periodo letivo) exclui o aluno. E ajuste no RM, nao no middleware.');
    const turmas = [...new Set(contexts.map((c) => c.ClassCode ?? '?'))].sort();
    console.log(`   Turmas no escopo atual da Sentenca: ${turmas.join(', ')}`);
    await pgPool.end();
    return;
  }
  console.log(`\n1. RM ......... OK — ${ctx.StudentName} | turma ${ctx.ClassCode ?? '(sem turma)'}`);

  // --- 2. Transformação ---
  const item = toSyncItem(ctx, enrichmentByCode.get(ra));
  if (!item) {
    console.log('\n2. Transform .. FALHOU — contexto sem RA ou sem nome; o aluno seria descartado.');
    await pgPool.end();
    return;
  }
  console.log(`2. Transform .. OK — chave de year group: ${item.yearGroupKey ?? '(nenhuma)'}`);

  // --- 3. Year group ---
  let yearGroupId: string | null = null;
  try {
    yearGroupId = await resolveYearGroupId(item.yearGroupKey);
    console.log(`3. YearGroup .. OK — ${yearGroupId}`);
  } catch (error) {
    console.log(`3. YearGroup .. FALHOU — ${error instanceof Error ? error.message : String(error)}`);
  }

  // --- 4. Estado no id_mapping e no Toddle ---
  const mapping = await idMappingRepository.findByRmCode('STUDENT', ra);
  const remote = await toddleClient.getStudentsBySourceIds([sourceId]);

  console.log(`4. id_mapping . ${mapping ? `OK — toddleId ${mapping.toddleId}` : 'ausente'}`);
  console.log(`5. Toddle ..... ${remote.length > 0 ? `EXISTE — id ${remote[0].id}, yearGroupId ${remote[0].yearGroupId ?? 'null'}` : 'nao existe'}`);

  console.log(`\n${'='.repeat(50)}`);
  if (remote.length > 0 || mapping) {
    console.log('VEREDITO: o proximo sync fara UPDATE (nao duplica).');
  } else if (yearGroupId) {
    console.log('VEREDITO: o proximo sync fara CREATE com o payload:');
    console.log('  ' + JSON.stringify(toCreatePayload(item, yearGroupId)));
  } else {
    console.log('VEREDITO: o sync FALHARIA — resolva o year group (item 3) antes.');
  }
  console.log('\nPara sincronizar agora: npm run enqueue:students (com o worker rodando).');

  await pgPool.end();
}

main().catch(async (error) => {
  console.error('falhou:', error instanceof Error ? error.message : error);
  await pgPool.end().catch(() => {});
  process.exit(1);
});
