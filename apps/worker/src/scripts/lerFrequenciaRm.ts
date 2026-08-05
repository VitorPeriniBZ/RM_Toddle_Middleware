import { env, logger } from '@rm-toddle/config';
import { idMappingRepository, pgPool } from '@rm-toddle/db';
import { fetchFrequenciaFromRm, type RmFalta } from '@rm-toddle/domain';

/**
 * Lê a frequência do RM e relata o que é projetável para o Toddle. SOMENTE
 * LEITURA — não escreve no RM, no Toddle nem no nosso banco.
 *
 * Uso:
 *   npm run ler:frequencia -- --de 2026-02-01 --ate 2026-02-28
 *   npm run ler:frequencia -- --de 2026-02-01 --ate 2026-06-30 --detalhe
 *
 * A janela é obrigatória: a Sentença exige, e são 21.300 linhas no ano inteiro
 * nos dois campi.
 */

function args(): { de: string; ate: string; detalhe: boolean } {
  const argv = process.argv.slice(2);
  const pega = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const de = pega('de');
  const ate = pega('ate');
  const ok = (v?: string): boolean => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v));
  if (!ok(de) || !ok(ate)) {
    throw new Error('Uso: --de YYYY-MM-DD --ate YYYY-MM-DD [--detalhe]');
  }
  return { de: de as string, ate: ate as string, detalhe: argv.includes('--detalhe') };
}

async function main(): Promise<void> {
  const { de, ate, detalhe } = args();

  const resumo = await fetchFrequenciaFromRm({ de, ate });

  // De-para, só ATIVOS — interseção positiva, igual ao shadow mode.
  const cursos = await idMappingRepository.listByType('COURSE', 'active');
  const alunos = await idMappingRepository.listByType('STUDENT', 'active');
  const periodos = await idMappingRepository.listByType('PERIOD', 'active');
  const cursoPorTd = new Map(cursos.map((c) => [c.rmCode, c.toddleId]));
  const alunoPorRa = new Map(alunos.map((a) => [a.rmCode, a.toddleId]));
  const periodoPorFaixa = new Map(periodos.map((p) => [p.rmCode, p.toddleId]));

  type Motivo = 'TURMA_NAO_MAPEADA' | 'ALUNO_NAO_MAPEADO' | 'FAIXA_NAO_MAPEADA' | 'SEM_FAIXA';
  const recusas: Record<string, number> = {};
  const projetaveis: RmFalta[] = [];

  for (const f of resumo.faltas) {
    let motivo: Motivo | null = null;
    if (!cursoPorTd.has(f.idTurmaDisc)) motivo = 'TURMA_NAO_MAPEADA';
    else if (!alunoPorRa.has(f.ra)) motivo = 'ALUNO_NAO_MAPEADO';
    else if (!f.faixa) motivo = 'SEM_FAIXA';
    else if (!periodoPorFaixa.has(f.faixa)) motivo = 'FAIXA_NAO_MAPEADA';

    if (motivo) recusas[motivo] = (recusas[motivo] ?? 0) + 1;
    else projetaveis.push(f);
  }

  const p = (s = ''): void => console.log(s);

  p('');
  p('══════════════════════════════════════════════════════════════════');
  p('  Frequência do RM — SOMENTE LEITURA. Nada foi escrito.');
  p('══════════════════════════════════════════════════════════════════');
  p(`  janela     ${de} → ${ate}`);
  p(`  sentença   ${env.RM_SENTENCA_FREQUENCIA}`);
  p(`  campus     RM_CODFILIAL=${env.RM_CODFILIAL}   coligada=${env.RM_CODCOLIGADA}`);
  p('');
  p('── o que o RM devolveu ───────────────────────────────────────────');
  p(`  linhas                       ${resumo.linhas}`);
  p(`  em escopo (após campus)      ${resumo.faltas.length}`);
  p(`  fora do escopo               ${resumo.foraDoEscopo}`);
  if (resumo.semRa) p(`  descartadas sem RA           ${resumo.semRa}`);
  p('');
  p(`  domínio de PRESENCA          ${JSON.stringify(resumo.dominioPresenca)}`);
  if (Object.keys(resumo.dominioPresenca).some((v) => v !== 'A')) {
    p('  ⚠ APARECEU VALOR DIFERENTE DE "A". Todo o desenho assume que o');
    p('    SFREQUENCIA guarda só ausência. Pare e investigue.');
  }
  p('');
  p('── autoria ───────────────────────────────────────────────────────');
  p(`  criadas pela integração      ${resumo.criadasPelaIntegracao}`);
  p(`  alteradas depois de criadas  ${resumo.alteradasDepoisDeCriadas}`);
  p(`  marca d'água (ALTERADO_EM)   ${resumo.marcaDagua ?? '—'}`);
  p('');
  p('  Regra de remoção: só é automática se a integração criou a ausência e');
  p(`  ninguém do RM a tocou depois. Elegíveis nesta janela: ${resumo.criadasPelaIntegracao}.`);
  p('  (CPF do autor não é propagado nem logado — só um hash com sal.)');
  p('');
  p('── de-para ───────────────────────────────────────────────────────');
  p(`  COURSE ativos ${cursos.length}   STUDENT ativos ${alunos.length}   PERIOD ativos ${periodos.length}`);
  p('');
  p(`  PROJETÁVEIS                  ${projetaveis.length} de ${resumo.faltas.length}`);
  if (Object.keys(recusas).length) {
    p('  recusadas:');
    for (const [m, n] of Object.entries(recusas).sort((a, b) => b[1] - a[1])) {
      p(`      ${m.padEnd(22)} ${String(n).padStart(6)}`);
    }
  }

  if (projetaveis.length) {
    const turmas = new Set(projetaveis.map((f) => f.idTurmaDisc));
    const ras = new Set(projetaveis.map((f) => f.ra));
    const datas = [...new Set(projetaveis.map((f) => f.data))].sort();
    p('');
    p(`  turma-disciplina  ${turmas.size}`);
    p(`  alunos            ${ras.size}`);
    p(`  datas             ${datas.length}  (${datas[0]} a ${datas[datas.length - 1]})`);

    const porFaixa = new Map<string, number>();
    for (const f of projetaveis) porFaixa.set(f.faixa ?? '?', (porFaixa.get(f.faixa ?? '?') ?? 0) + 1);
    p(`  por faixa         ${JSON.stringify(Object.fromEntries([...porFaixa].sort()))}`);
    p(`  justificadas      ${projetaveis.filter((f) => f.justificada).length}`);

    if (detalhe) {
      p('');
      p('  amostra (o que iria para o Toddle):');
      for (const f of projetaveis.slice(0, 5)) {
        p(`      RA ${f.ra} → student ${alunoPorRa.get(f.ra)}`);
        p(`      td ${f.idTurmaDisc} → course ${cursoPorTd.get(f.idTurmaDisc)}`);
        p(`      ${f.data} faixa ${f.faixa} → period ${periodoPorFaixa.get(f.faixa ?? '')}` +
          `  (${f.horaInicial}-${f.horaFinal}, dia ${f.diaSemana})`);
        p('');
      }
    }
  }

  p('══════════════════════════════════════════════════════════════════');
  p('  Nada foi escrito. Publicar no Toddle ainda depende do');
  p('  POST /public/v2/attendance, que hoje recusa.');
  p('══════════════════════════════════════════════════════════════════');
  p('');
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'ler:frequencia falhou');
    process.exitCode = 1;
  })
  .finally(() => pgPool.end());
