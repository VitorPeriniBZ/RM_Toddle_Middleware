import { env, logger } from '@rm-toddle/config';
import { idMappingRepository, pgPool } from '@rm-toddle/db';
import { fetchResponsaveisFromRm } from '@rm-toddle/domain';

/**
 * Lê os responsáveis ACADÊMICOS do RM e relata o que iria para o Toddle.
 * SOMENTE LEITURA — nada é escrito no RM, no Toddle nem no nosso banco.
 *
 *   npm run ler:responsaveis
 *   npm run ler:responsaveis -- --detalhe
 *
 * O financeiro está fora por decisão da escola: criar parent dá acesso ao LMS, e o
 * lado financeiro inclui pessoa jurídica (um instituto de bolsa aparece como
 * responsável de 8 alunos de 7 famílias).
 */
async function main(): Promise<void> {
  const detalhe = process.argv.includes('--detalhe');

  const alunos = await idMappingRepository.listByType('STUDENT', 'active');
  const ras = alunos.map((a) => a.rmCode);
  const parents = await idMappingRepository.listByType('PARENT', 'active');

  const r = await fetchResponsaveisFromRm(ras);

  const p = (s = ''): void => console.log(s);
  p('');
  p('══════════════════════════════════════════════════════════════════');
  p('  Responsáveis ACADÊMICOS — SOMENTE LEITURA. Nada foi escrito.');
  p('══════════════════════════════════════════════════════════════════');
  p(`  sentença   ${env.RM_SENTENCA_RESPONSAVEIS}`);
  p(`  escopo     ${ras.length} alunos com mapeamento STUDENT ativo`);
  p('');
  p('── o que o RM devolveu ───────────────────────────────────────────');
  p(`  linhas                       ${r.linhas}`);
  p(`  fora do escopo               ${r.foraDoEscopo}`);
  p('');
  p('── responsáveis consolidados por e-mail ──────────────────────────');
  p(`  PARENTS que o Toddle receberia   ${r.responsaveis.length}`);
  p(`  de-para PARENT já existente      ${parents.length}`);

  const porFilhos = new Map<number, number>();
  for (const g of r.responsaveis) porFilhos.set(g.ras.length, (porFilhos.get(g.ras.length) ?? 0) + 1);
  p(`  filhos por parent                ${JSON.stringify(Object.fromEntries([...porFilhos].sort((a, b) => a[0] - b[0])))}`);

  const alunosCobertos = new Set(r.responsaveis.flatMap((g) => g.ras));
  p(`  alunos cobertos                  ${alunosCobertos.size} de ${ras.length}`);

  p('');
  p(`  parentesco: ${JSON.stringify(r.dominioParentesco)}`);

  const duplicados = r.responsaveis.filter((g) => g.codigosRm.length > 1);
  if (duplicados.length) {
    p('');
    p(`  ⚠ ${duplicados.length} responsável(is) com mais de um CODPESSOA (cadastro duplicado no RM)`);
  }

  if (r.pendencias.length) {
    p('');
    p('── pendências: NÃO viram parent ──────────────────────────────────');
    const porMotivo = new Map<string, number>();
    for (const x of r.pendencias) porMotivo.set(x.motivo, (porMotivo.get(x.motivo) ?? 0) + 1);
    for (const [m, n] of porMotivo) p(`  ${m.padEnd(28)} ${n}`);
    p('');
    p('  precisam da secretaria — e-mail NÃO deve ser inventado:');
    for (const x of r.pendencias) {
      p(`      RA ${x.ra}  ${x.aluno}`);
      p(`          responsável: ${x.nomeResponsavel ?? '(nenhum acadêmico)'}  [${x.motivo}]`);
    }
  }

  if (r.colisoes.length) {
    p('');
    p('── ⚠ COLISÃO: um e-mail, pessoas diferentes ──────────────────────');
    p('  No Toddle o e-mail é a identidade, então só UMA delas pode existir.');
    p('  Isto é decisão da escola — o código não escolhe.');
    p('');
    for (const c of r.colisoes) {
      p(`  ${c.email}`);
      p(`      nomes: ${c.nomes.join('  |  ')}`);
      p(`      alunos: ${c.ras.join(', ')}`);
    }
  }

  if (detalhe) {
    p('');
    p('── amostra do payload (os 5 com mais filhos) ─────────────────────');
    for (const g of r.responsaveis.slice(0, 5)) {
      p(`  ${g.email}`);
      p(`      firstName="${g.primeiroNome}"  lastName="${g.sobrenome}"`);
      p(`      children (RA): ${g.ras.join(', ')}`);
      p(`      relationships: ${JSON.stringify(g.parentescoPorRa)}`);
      p(`      CODPESSOA: ${g.codigosRm.join(', ') || '—'}   nomeHash: ${g.nomeHash}`);
      p('');
    }
  }

  p('══════════════════════════════════════════════════════════════════');
  p('  Nada foi escrito. Criar parent DÁ ACESSO ao LMS — a decisão de');
  p('  quem entra é da escola, e as colisões acima precisam de resposta.');
  p('══════════════════════════════════════════════════════════════════');
  p('');
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'ler:responsaveis falhou');
    process.exitCode = 1;
  })
  .finally(() => pgPool.end());
