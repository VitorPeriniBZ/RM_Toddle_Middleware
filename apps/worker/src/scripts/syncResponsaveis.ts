import { env, logger } from '@rm-toddle/config';
import { idMappingRepository, pgPool } from '@rm-toddle/db';
import { fetchResponsaveisFromRm, type Responsavel } from '@rm-toddle/domain';
import { comPaciencia, toddleClient } from '@rm-toddle/integrations';

/**
 * Cria os responsáveis ACADÊMICOS no Toddle, com os filhos vinculados.
 *
 *   npm run sync:responsaveis                        # plano, não escreve nada
 *   npm run sync:responsaveis -- --executar --limite 3   # canário
 *   npm run sync:responsaveis -- --executar          # o resto
 *
 * ─── O QUE ESTA ESCRITA SIGNIFICA ───────────────────────────────────────────
 *
 * Criar parent no Toddle **dá acesso ao LMS**: a pessoa passa a ver nota,
 * frequência e comunicado dos filhos vinculados. Não é sincronização de dado, é
 * concessão de acesso — e **não existe DELETE de parent** na API (só POST, PUT e
 * GET). Desfazer depende de PUT ou do portal.
 *
 * Por isso: só o responsável acadêmico (o financeiro inclui pessoa jurídica),
 * ensaio por padrão, `--limite` para canário, e o de-para gravado imediatamente
 * após cada POST.
 *
 * ─── IDEMPOTÊNCIA EM DUAS CAMADAS ───────────────────────────────────────────
 *
 * 1. `id_mapping` tipo `PARENT`, chaveado pelo e-mail.
 * 2. `GET /parents`, que devolve e-mail — então mesmo perdendo a camada 1 dá para
 *    recuperar. Melhor que período, cujo de-para só vive no nosso banco.
 */

const INTERVALO_MS = 250;
const dorme = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const executar = argv.includes('--executar');
  const iLimite = argv.indexOf('--limite');
  const limite = iLimite >= 0 ? Number(argv[iLimite + 1]) : Infinity;

  await toddleClient.assertTargetOrganization();

  const alunos = await idMappingRepository.listByType('STUDENT', 'active');
  const studentIdPorRa = new Map(alunos.map((a) => [a.rmCode, a.toddleId]));
  const resumo = await fetchResponsaveisFromRm(alunos.map((a) => a.rmCode));

  // Camada 1: de-para local. Camada 2: o que o Toddle já tem, por e-mail.
  const mapeados = await idMappingRepository.listByType('PARENT', 'active');
  const porEmailLocal = new Map(mapeados.map((m) => [m.rmCode, m]));
  const noToddle = new Map(
    (await toddleClient.listParents())
      .filter((p) => p.email)
      .map((p) => [String(p.email).toLowerCase().trim(), p]),
  );

  const aCriar: Responsavel[] = [];
  const jaExistem: Responsavel[] = [];
  const semFilhoMapeado: Responsavel[] = [];

  for (const r of resumo.responsaveis) {
    // Interseção positiva: todo filho precisa de studentId. Sem isso o POST
    // recusaria, e mandar parent sem filho criaria acesso pendurado em nada.
    const children = r.ras.map((ra) => studentIdPorRa.get(ra)).filter((x): x is string => Boolean(x));
    if (children.length !== r.ras.length) {
      semFilhoMapeado.push(r);
      continue;
    }
    if (porEmailLocal.has(r.email) || noToddle.has(r.email)) jaExistem.push(r);
    else aCriar.push(r);
  }

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Responsáveis acadêmicos → Toddle');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  organização        ${env.TODDLE_ORG_ID}`);
  console.log(`  alunos em escopo   ${alunos.length}`);
  console.log('');
  console.log(`  responsáveis lidos do RM       ${resumo.responsaveis.length}`);
  console.log(`  já existem (de-para ou API)    ${jaExistem.length}`);
  console.log(`  A CRIAR                        ${aCriar.length}`);
  if (semFilhoMapeado.length) {
    console.log(`  ⚠ com filho sem mapeamento     ${semFilhoMapeado.length}  (recusados)`);
  }
  if (resumo.pendencias.length) {
    console.log(`  pendências (sem e-mail)        ${resumo.pendencias.length}  — secretaria`);
  }
  if (resumo.colisoes.length) {
    console.log('');
    console.log(`  ⚠⚠ ${resumo.colisoes.length} COLISÃO(ÕES) de e-mail — ABORTANDO`);
    for (const c of resumo.colisoes) {
      console.log(`      ${c.email}: ${c.nomes.join(' | ')}`);
    }
    console.log('  No Toddle o e-mail é a identidade. Escolher quem existe é decisão');
    console.log('  da escola, não do código. Resolva antes de criar.');
    process.exitCode = 1;
    return;
  }

  const filhos = aCriar.reduce((s, r) => s + r.ras.length, 0);
  console.log('');
  console.log(`  vínculos parent-filho que serão criados: ${filhos}`);
  console.log('');
  console.log('  ⚠ Criar parent DÁ ACESSO ao LMS. Não existe DELETE de parent na API.');

  if (!executar) {
    console.log('\n  NADA FOI ESCRITO. --executar para criar.');
    console.log('  Sugestão: comece com --limite 3 e confira no portal.\n');
    return;
  }

  const lote = Number.isFinite(limite) ? aCriar.slice(0, limite) : aCriar;
  console.log(`\n  criando ${lote.length} de ${aCriar.length}…\n`);

  let criados = 0;
  let falhas = 0;

  for (const r of lote) {
    const children = r.ras.map((ra) => studentIdPorRa.get(ra) as string);
    const relationships = r.ras
      .filter((ra) => r.parentescoPorRa[ra])
      .map((ra) => ({ childId: studentIdPorRa.get(ra) as string, relationship: r.parentescoPorRa[ra] }));

    try {
      const criado = await comPaciencia(() =>
        toddleClient.createParent({
          firstName: r.primeiroNome,
          lastName: r.sobrenome,
          email: r.email,
          children,
          ...(relationships.length ? { relationships } : {}),
        }),
      );

      // Grava o de-para IMEDIATAMENTE. Se o processo morrer entre o POST e o
      // upsert, o parent fica órfão — e sem DELETE, órfão é permanente. Uma linha
      // por vez limita o dano a um registro.
      await idMappingRepository.upsert({
        entityType: 'PARENT',
        rmCode: r.email,
        toddleId: criado.id,
        rmInternalId: r.codigosRm[0] ?? null,
      });

      criados += 1;
      // Não logar e-mail nem nome: dado pessoal não entra em log JSON.
      logger.info(
        { parentId: criado.id, filhos: children.length, nomeHash: r.nomeHash },
        'Responsável criado e vinculado',
      );
      await dorme(INTERVALO_MS);
    } catch (error) {
      falhas += 1;
      logger.error(
        { err: error, nomeHash: r.nomeHash, filhos: children.length },
        'Responsável falhou — seguindo com os próximos',
      );
      if (falhas >= 5) {
        throw new Error(`${falhas} falhas — abortando. Investigue antes de continuar.`);
      }
    }
  }

  console.log(`\n  criados: ${criados}   falhas: ${falhas}`);
  console.log('\n  Confira com: npm run ler:responsaveis\n');
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'sync:responsaveis falhou');
    process.exitCode = 1;
  })
  .finally(() => pgPool.end());
