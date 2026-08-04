import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { configVersion, configVersionDetalhe, env, logger } from '@rm-toddle/config';
import { idMappingRepository, pgPool } from '@rm-toddle/db';
import { toddleClient } from '@rm-toddle/integrations';
import {
  montaLotes,
  PeriodTimeIndex,
  projetaLote,
  RmAttendanceTargets,
  POLITICA_PRESENCA,
  type ContextoProjecao,
} from '@rm-toddle/domain';

/**
 * SHADOW MODE da via Toddle -> TOTVS RM.
 *
 * Lê a frequência lançada no Toddle, resolve os alvos no RM, monta o XML que o
 * `SaveRecord` receberia — e PARA. Nenhuma escrita: nem no RM, nem no Toddle,
 * nem no nosso banco. O único efeito colateral são arquivos em disco.
 *
 * Uso:
 *   npm run shadow:frequencia -- --de 2026-03-02 --ate 2026-03-06
 *   npm run shadow:frequencia -- --de 2026-03-02 --ate 2026-03-06 --turma 1233
 *   npm run shadow:frequencia -- --de 2026-03-02 --ate 2026-03-06 --saida /tmp/xmls
 *
 * A janela de datas é OBRIGATÓRIA. Sem ela a chamada traria as dezenas de
 * milhares de registros de demonstração do tenant, e o custo de um engano num
 * ambiente que ainda não tem aprovação humana é alto o bastante para preferir
 * uma recusa a um padrão conveniente.
 */

const TETO_REGISTROS = 20_000;

interface Args {
  de: string;
  ate: string;
  turma?: string;
  saida: string;
  /**
   * Lê SEM o filtro de courseIds. Serve para provar que a guarda recusa o que
   * não está mapeado — com o filtro ligado, dado de demonstração nem chega à
   * projeção, e aí o relatório não mostra que ela o barraria.
   */
  diagnostico: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const pega = (nome: string): string | undefined => {
    const i = argv.indexOf(`--${nome}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const de = pega('de');
  const ate = pega('ate');
  const dataOk = (v: string | undefined): boolean => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v));

  if (!dataOk(de) || !dataOk(ate)) {
    throw new Error(
      'Faltou a janela de datas. Uso: --de YYYY-MM-DD --ate YYYY-MM-DD ' +
        '[--turma IDTURMADISC] [--saida DIR]\n' +
        'A janela é obrigatória de propósito: sem filtro, o GET /attendance deste ' +
        'tenant devolve dezenas de milhares de registros de DEMONSTRAÇÃO.',
    );
  }
  if ((de as string) > (ate as string)) {
    throw new Error(`Janela invertida: --de ${de} é depois de --ate ${ate}.`);
  }

  return {
    de: de as string,
    ate: ate as string,
    turma: pega('turma'),
    saida: pega('saida') ?? resolve(process.cwd(), 'backups', 'shadow-frequencia'),
    diagnostico: argv.includes('--diagnostico'),
  };
}

/** Um único campus. "ALL" não vale: o contexto do wsDataServer exige um CODFILIAL. */
function campusUnico(): string {
  const campi = env.RM_CODFILIAL.split(',').map((c) => c.trim()).filter(Boolean);
  if (env.RM_CODFILIAL.toUpperCase() === 'ALL' || campi.length !== 1) {
    throw new Error(
      `RM_CODFILIAL="${env.RM_CODFILIAL}" não serve para o shadow mode: o contexto do ` +
        'wsDataServer exige UM CODFILIAL. Rode um campus por vez.',
    );
  }
  return campi[0];
}

async function main(): Promise<void> {
  const args = parseArgs();
  const codFilial = campusUnico();
  const versao = configVersion();

  logger.info(
    { ...configVersionDetalhe(), configVersion: versao, janela: `${args.de} → ${args.ate}`, codFilial },
    'Shadow mode da frequência — NENHUMA escrita será feita',
  );

  // Confirma a organização antes de ler. Mapeamento é por organização; ler de uma
  // e resolver contra o de-para de outra produziria projeção plausível e errada.
  await toddleClient.assertTargetOrganization();

  // ─── de-para, só ATIVOS (interseção positiva) ─────────────────────────────
  const cursos = await idMappingRepository.listByType('COURSE', 'active');
  const alunos = await idMappingRepository.listByType('STUDENT', 'active');

  const cursoParaTurmaDisc = new Map(cursos.map((m) => [m.toddleId, m.rmCode]));
  const alunoParaRa = new Map(alunos.map((m) => [m.toddleId, m.rmCode]));

  let turmasEmEscopo = cursos.map((m) => m.rmCode);
  let cursosFiltrados = cursos;
  if (args.turma) {
    if (!turmasEmEscopo.includes(args.turma)) {
      throw new Error(
        `--turma ${args.turma} não está entre as turmas-disciplina com mapeamento COURSE ativo.`,
      );
    }
    turmasEmEscopo = [args.turma];
    cursosFiltrados = cursos.filter((m) => m.rmCode === args.turma);
    cursoParaTurmaDisc.clear();
    for (const m of cursosFiltrados) cursoParaTurmaDisc.set(m.toddleId, m.rmCode);
  }

  logger.info(
    { cursosAtivos: cursos.length, alunosAtivos: alunos.length, turmasEmEscopo: turmasEmEscopo.length },
    'De-para carregado',
  );

  // ─── alvos no RM ──────────────────────────────────────────────────────────
  const alvos = await RmAttendanceTargets.carregar(turmasEmEscopo, codFilial);
  const semHorario = alvos.turmaDiscSemHorario(turmasEmEscopo);

  // ─── horas das aulas no Toddle ────────────────────────────────────────────
  // O registro de frequência vem SEM hora (medido: nula em 800 de 800). A hora
  // mora no periodSet do bell schedule, e a rota exige academicYearIds.
  const anos = await toddleClient.listAcademicYears();
  const anosIds = anos.map((a) => String(a.id)).filter(Boolean);
  const bellSchedules = anosIds.length ? await toddleClient.listBellSchedules(anosIds) : [];
  const periodos = bellSchedules.length
    ? PeriodTimeIndex.deBellSchedules(bellSchedules)
    : PeriodTimeIndex.vazio();

  // ─── origem: frequência do Toddle ─────────────────────────────────────────
  if (args.diagnostico) {
    logger.warn(
      'Modo diagnóstico: lendo SEM filtro de curso. Continua sendo leitura — serve para ' +
        'mostrar o que a projeção recusaria.',
    );
  }
  const registros = await toddleClient.listAttendance({
    startDate: args.de,
    endDate: args.ate,
    ...(args.diagnostico ? {} : { courseIds: cursosFiltrados.map((m) => m.toddleId) }),
    maxRecords: TETO_REGISTROS,
  });

  const ctx: ContextoProjecao = {
    codColigada: env.RM_CODCOLIGADA,
    cursoParaTurmaDisc,
    alunoParaRa,
    alvos,
    periodos,
  };

  const resumo = projetaLote(registros, ctx);
  const lotes = montaLotes(resumo.projetados);

  // ─── relatório ────────────────────────────────────────────────────────────
  const linhas: string[] = [];
  const p = (s = ''): void => {
    linhas.push(s);
    // eslint-disable-next-line no-console
    console.log(s);
  };

  p('');
  p('══════════════════════════════════════════════════════════════════');
  p('  SHADOW MODE — frequência Toddle -> RM.  NADA FOI ESCRITO.');
  p('══════════════════════════════════════════════════════════════════');
  p(`  janela         ${args.de} → ${args.ate}`);
  p(`  campus         CODFILIAL=${codFilial}   coligada=${env.RM_CODCOLIGADA}`);
  p(`  configVersion  ${versao}`);
  p(`  organização    ${env.TODDLE_ORG_ID}`);
  if (args.diagnostico) p('  modo           DIAGNÓSTICO (sem filtro de curso na origem)');
  p('');
  p('── escopo ────────────────────────────────────────────────────────');
  p(`  turma-disciplina com mapeamento ativo   ${turmasEmEscopo.length}`);
  p(`  alunos com mapeamento ativo             ${alunos.length}`);
  p(`  horários no índice                      ${alvos.totalHorarios}`);
  p(`  etapas de falta graváveis               ${alvos.totalEtapas}`);
  p(`  faixas de horário distintas             ${alvos.faixas.length}  (${alvos.faixas.join(', ')})`);
  if (semHorario.length) {
    p(`  ⚠ turma-disciplina SEM horário          ${semHorario.length} → ${semHorario.slice(0, 10).join(', ')}`);
  }
  p('');
  p('── grade de horário do Toddle × do RM ────────────────────────────');
  p(`  anos acadêmicos                         ${anosIds.length}`);
  p(`  bell schedules                          ${bellSchedules.length}`);
  for (const g of periodos.bellSchedules) {
    p(`      "${g.label}"  ${String(g.periodos).padStart(2)} períodos  currículo ${g.curriculumId}`);
  }
  p(`  períodos com hora                       ${periodos.totalPeriodos}`);
  if (periodos.ambiguos.length) {
    p(`  ⚠ períodos AMBÍGUOS (hora depende da grade)  ${periodos.ambiguos.length}`);
  }
  p(`  faixas no Toddle: ${periodos.faixas.length}`);
  p(`  faixas no RM:     ${alvos.faixas.length}`);
  const emComum = periodos.faixas.filter((f) => alvos.faixas.includes(f));
  p(`  faixas EM COMUM:  ${emComum.length}${emComum.length ? ` (${emComum.join(', ')})` : '  ← sem interseção'}`);
  if (emComum.length === 0 && periodos.faixas.length > 0) {
    p('    As duas grades não se encontram: a do Toddle é de demonstração e a do');
    p('    campus 2 nunca foi cadastrada lá. Enquanto isso, nenhum lançamento real');
    p('    do Toddle tem como apontar para uma aula do RM.');
  }
  p('');
  p('── origem ────────────────────────────────────────────────────────');
  p(`  registros lidos do Toddle               ${resumo.lidos}`);
  p('  opções de chamada encontradas:');
  for (const [opcao, n] of Object.entries(resumo.opcoesVistas).sort((a, b) => b[1] - a[1])) {
    const abrev = /\[(.*)\]$/.exec(opcao)?.[1]?.toUpperCase() ?? '';
    const temPolitica = Object.prototype.hasOwnProperty.call(POLITICA_PRESENCA, abrev);
    p(`      ${temPolitica ? '✓' : '✗'} ${opcao.padEnd(34)} ${String(n).padStart(6)}`);
  }
  p('');
  p('── projeção ──────────────────────────────────────────────────────');
  p(`  PROJETÁVEIS                             ${resumo.projetados.length}`);
  p(`  recusados                               ${resumo.recusados.length}`);
  if (Object.keys(resumo.porMotivo).length) {
    p('  motivos de recusa:');
    for (const [motivo, n] of Object.entries(resumo.porMotivo).sort((a, b) => b[1] - a[1])) {
      p(`      ${motivo.padEnd(26)} ${String(n).padStart(6)}`);
    }
    p('');
    p('  amostra de recusas (uma por motivo):');
    const vistos = new Set<string>();
    for (const r of resumo.recusados) {
      if (vistos.has(r.motivo)) continue;
      vistos.add(r.motivo);
      p(`      [${r.motivo}] toddle#${r.origemId}`);
      p(`          ${r.detalhe}`);
    }
  }

  if (resumo.colisoes.length) {
    p('');
    p(`  ⚠ COLISÃO DE CHAVE NATURAL: ${resumo.colisoes.length}`);
    p('    Registros DIFERENTES do Toddle projetam na mesma PK do RM. O dataset do RM');
    p('    vem com EnforceConstraints="False" e não rejeita isso. Vai para revisão —');
    p('    nunca "vence o último".');
    for (const c of resumo.colisoes.slice(0, 10)) {
      p(`      ${c.chaveRm}  ←  toddle#${c.origemIds.join(', #')}`);
    }
  }

  p('');
  p('── o que SERIA enviado ───────────────────────────────────────────');
  p(`  datasets (um por IDTURMADISC + CODETAPA)  ${lotes.length}`);
  for (const lote of lotes.slice(0, 15)) {
    p(`      IDTURMADISC ${lote.idTurmaDisc.padStart(5)}  etapa ${lote.codEtapa}  ` +
      `${String(lote.linhas.length).padStart(4)} lançamento(s)  ${lote.ras.length} aluno(s)`);
  }
  if (lotes.length > 15) p(`      … e ${lotes.length - 15} outro(s)`);

  // ─── arquivos ─────────────────────────────────────────────────────────────
  if (lotes.length > 0) {
    mkdirSync(args.saida, { recursive: true });
    for (const lote of lotes) {
      const nome = `freq_td${lote.idTurmaDisc}_etapa${lote.codEtapa}_${args.de}_${args.ate}.xml`;
      writeFileSync(resolve(args.saida, nome), `${lote.xml}\n`, 'utf-8');
    }
    p('');
    p(`  XMLs gravados em ${args.saida}`);
    p('');
    p('── primeiro dataset, na íntegra ──────────────────────────────────');
    p(lotes[0].xml);
  }

  p('');
  p('══════════════════════════════════════════════════════════════════');
  p('  Nenhum SaveRecord foi chamado. O cliente do wsDataServer não tem');
  p('  método de escrita — ver o comentário no topo de wsDataServerClient.ts.');
  p('══════════════════════════════════════════════════════════════════');
  p('');

  if (lotes.length > 0) {
    mkdirSync(args.saida, { recursive: true });
    writeFileSync(resolve(args.saida, `RELATORIO_${args.de}_${args.ate}.txt`), `${linhas.join('\n')}\n`, 'utf-8');
  }
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'Shadow mode falhou');
    process.exitCode = 1;
  })
  .finally(() => pgPool.end());
