import { env, logger } from '@rm-toddle/config';
import { idMappingRepository, pgPool } from '@rm-toddle/db';
import { toddleClient, wsDataServerClient } from '@rm-toddle/integrations';

/**
 * Compara as turma-disciplina do RM com o nosso de-para e relata a DERIVA.
 * SOMENTE LEITURA — não cria, não arquiva, não altera nada.
 *
 *   npm run reconciliar:turmas
 *   npm run reconciliar:turmas -- --tudo    # inclui as sem aluno
 *
 * ─── POR QUE ISTO EXISTE ────────────────────────────────────────────────────
 *
 * Os 185 `COURSE` vieram de uma carga manual (CSV de 03/08/2026) e **nada os
 * atualiza**. O de-para de turma é um retrato, não uma sincronização: toda
 * turma-disciplina criada depois fica invisível para a integração.
 *
 * Foi assim que a `1714` (EAVHS10IA / ELA Higher Level) ficou de fora com 60
 * faltas lançadas — e só apareceu por acidente, ao cruzar frequência. O objetivo
 * aqui é a deriva ser DETECTADA em vez de descoberta.
 *
 * ─── FONTE: DataServer, não Sentença ────────────────────────────────────────
 *
 * `EduTurmaDiscData` devolve as 217 turma-disciplina do campus em UMA chamada,
 * com 39 colunas — inclusive as quatro de auditoria. Chegou a existir uma
 * especificação de Sentença para isso (`TODDLE.TURMADISC`), escrita quando o
 * objetivo era CRIAR as turmas; para reconciliar, ela é desnecessária. O que a
 * Sentença ainda resolveria é o PROFESSOR, que este DataServer não traz.
 */

type Situacao =
  | 'OK'
  | 'NOVA_COM_ALUNOS'
  | 'NOVA_SEM_ALUNOS'
  | 'INATIVADA_NO_RM'
  | 'REATIVADA_NO_RM'
  | 'SUMIU_DO_RM';

interface Achado {
  situacao: Situacao;
  idTurmaDisc: string;
  codTurma?: string;
  codDisc?: string;
  nomeDisc?: string;
  ativa?: string;
  alunos?: number;
  criadoEm?: string;
  alteradoEm?: string;
}

const soData = (v: string | undefined): string => (v ?? '').slice(0, 10);

async function main(): Promise<void> {
  const tudo = process.argv.includes('--tudo');

  // ─── o RM ─────────────────────────────────────────────────────────────────
  const doRm = await wsDataServerClient.readView(
    'EduTurmaDiscData',
    `STurmaDisc.CODCOLIGADA=${env.RM_CODCOLIGADA} AND STurmaDisc.CODFILIAL=${env.RM_CODFILIAL}`,
    'STURMADISC',
    env.RM_CODFILIAL,
  );

  // O período letivo corrente do campus. Vem do que as turmas mapeadas usam, para
  // não fixar "15" no código — IDPERLET é por filial e muda todo ano.
  const ativos = await idMappingRepository.listByType('COURSE', 'active');
  const arquivados = await idMappingRepository.listByType('COURSE', 'archived');
  const mapeadas = new Map(ativos.map((c) => [c.rmCode, c]));
  const jaArquivadas = new Set(arquivados.map((c) => c.rmCode));

  const perletsMapeados = new Map<string, number>();
  for (const r of doRm) {
    if (mapeadas.has(r.IDTURMADISC)) {
      perletsMapeados.set(r.IDPERLET, (perletsMapeados.get(r.IDPERLET) ?? 0) + 1);
    }
  }
  const perlet = [...perletsMapeados.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!perlet) {
    throw new Error(
      'Não consegui inferir o período letivo corrente: nenhuma turma mapeada apareceu na ' +
        'leitura do RM. Pare e investigue — o escopo pode estar errado.',
    );
  }

  const doPerlet = doRm.filter((r) => r.IDPERLET === perlet);

  // ─── quem tem aluno: distingue turma real de oferta vazia ────────────────
  // As 16 turmas "IG" estão ativas e sem um único aluno. Sem este sinal, elas
  // apareceriam como lacuna e poluiriam o relatório todo mês.
  const alunosPorTd = new Map<string, Set<string>>();
  try {
    const cursos = ativos.map((c) => c.rmCode);
    const alunos = (await idMappingRepository.listByType('STUDENT', 'active')).map((a) => a.rmCode);
    const { fetchNotasFromRm } = await import('@rm-toddle/domain');
    // Passa TODAS as turma-disciplina do RM como escopo, não só as mapeadas —
    // senão a turma nova (que é o que procuramos) seria filtrada.
    const r = await fetchNotasFromRm(doPerlet.map((x) => x.IDTURMADISC), alunos);
    for (const n of r.notas) {
      if (!alunosPorTd.has(n.idTurmaDisc)) alunosPorTd.set(n.idTurmaDisc, new Set());
      alunosPorTd.get(n.idTurmaDisc)?.add(n.ra);
    }
    void cursos;
  } catch (e) {
    logger.warn(
      { err: e },
      'Não consegui medir alunos por turma (Sentença de notas) — o relatório sai sem esse sinal',
    );
  }

  // ─── compara ──────────────────────────────────────────────────────────────
  const achados: Achado[] = [];
  const vistas = new Set<string>();

  for (const r of doPerlet) {
    const id = r.IDTURMADISC;
    vistas.add(id);
    const ativaNoRm = (r.ATIVA ?? '').toUpperCase() === 'S';
    const alunos = alunosPorTd.get(id)?.size ?? 0;
    const base = {
      idTurmaDisc: id,
      codTurma: r.CODTURMA,
      codDisc: r.CODDISC,
      nomeDisc: r.NOMEDISC,
      ativa: r.ATIVA,
      alunos,
      criadoEm: soData(r.RECCREATEDON),
      alteradoEm: soData(r.RECMODIFIEDON),
    };

    if (mapeadas.has(id)) {
      achados.push({ ...base, situacao: ativaNoRm ? 'OK' : 'INATIVADA_NO_RM' });
    } else if (jaArquivadas.has(id)) {
      if (ativaNoRm) achados.push({ ...base, situacao: 'REATIVADA_NO_RM' });
    } else if (ativaNoRm) {
      achados.push({ ...base, situacao: alunos > 0 ? 'NOVA_COM_ALUNOS' : 'NOVA_SEM_ALUNOS' });
    }
  }

  for (const [id] of mapeadas) {
    if (!vistas.has(id)) achados.push({ situacao: 'SUMIU_DO_RM', idTurmaDisc: id });
  }

  // ─── deriva de rótulo: o título no Toddle ainda bate com o RM? ───────────
  const nossos = new Set(ativos.map((c) => c.toddleId));
  const classes = (await toddleClient.listClasses()).filter((c) => nossos.has(String(c.id)));
  const tituloPorTd = new Map<string, string>();
  for (const c of ativos) {
    const t = classes.find((x) => String(x.id) === c.toddleId);
    if (t) tituloPorTd.set(c.rmCode, String(t.title ?? ''));
  }
  const renomeadas = doPerlet.filter((r) => {
    const titulo = tituloPorTd.get(r.IDTURMADISC);
    const disc = (r.NOMEDISC ?? '').trim();
    if (!titulo || !disc) return false;
    return !titulo.toLowerCase().includes(disc.toLowerCase());
  });

  // ─── relatório ────────────────────────────────────────────────────────────
  const por = (s: Situacao): Achado[] => achados.filter((a) => a.situacao === s);
  const p = (t = ''): void => console.log(t);

  p('');
  p('══════════════════════════════════════════════════════════════════');
  p('  Reconciliação de turma-disciplina — RM × de-para');
  p('  SOMENTE LEITURA. Nada foi criado, arquivado ou alterado.');
  p('══════════════════════════════════════════════════════════════════');
  p(`  campus ${env.RM_CODFILIAL}   coligada ${env.RM_CODCOLIGADA}   IDPERLET ${perlet}`);
  p('');
  p(`  turma-disciplina no RM (campus)        ${doRm.length}`);
  p(`  do período letivo corrente             ${doPerlet.length}`);
  p(`  mapeamentos COURSE ativos              ${mapeadas.size}`);
  p(`  mapeamentos COURSE arquivados          ${jaArquivadas.size}`);
  p('');
  p('── situação ──────────────────────────────────────────────────────');
  const ordem: Situacao[] = [
    'OK', 'NOVA_COM_ALUNOS', 'INATIVADA_NO_RM', 'REATIVADA_NO_RM', 'SUMIU_DO_RM', 'NOVA_SEM_ALUNOS',
  ];
  for (const s of ordem) {
    const n = por(s).length;
    if (n === 0) continue;
    const marca = ['NOVA_COM_ALUNOS', 'REATIVADA_NO_RM', 'SUMIU_DO_RM'].includes(s) ? '⚠' : ' ';
    p(`  ${marca} ${s.padEnd(20)} ${String(n).padStart(4)}`);
  }

  const precisaAcao = [...por('NOVA_COM_ALUNOS'), ...por('REATIVADA_NO_RM'), ...por('SUMIU_DO_RM')];
  if (precisaAcao.length) {
    p('');
    p('── ⚠ PRECISA DE AÇÃO ─────────────────────────────────────────────');
    for (const a of precisaAcao) {
      p(`  [${a.situacao}]  IDTURMADISC ${a.idTurmaDisc}`);
      if (a.codTurma) {
        p(`      ${a.codTurma}  ${a.codDisc}  ${a.nomeDisc}`);
        p(`      alunos com nota: ${a.alunos}   criada ${a.criadoEm}   alterada ${a.alteradoEm}`);
      }
    }
  }

  const inativadas = por('INATIVADA_NO_RM');
  if (inativadas.length) {
    p('');
    p('── mapeadas e INATIVAS no RM (candidatas a arquivar) ─────────────');
    for (const a of inativadas) {
      p(`  ${a.idTurmaDisc}  ${a.codTurma}  ${a.codDisc}  ${a.nomeDisc}   alunos=${a.alunos}`);
    }
  }

  const vazias = por('NOVA_SEM_ALUNOS');
  if (vazias.length) {
    p('');
    p(`── sem mapeamento e SEM ALUNO: ${vazias.length} ─────────────────────────────`);
    p('  Oferta criada no RM e nunca enturmada. Não é lacuna — ignorar é correto.');
    if (tudo) {
      for (const a of vazias) p(`      ${a.idTurmaDisc}  ${a.codTurma}  ${a.codDisc}  ${a.nomeDisc}`);
    } else {
      const turmas = [...new Set(vazias.map((a) => a.codTurma))].sort();
      p(`  turmas: ${turmas.join(', ')}`);
      p('  (--tudo para listar uma a uma)');
    }
  }

  if (renomeadas.length) {
    p('');
    p('── ⚠ título no Toddle não contém mais o nome da disciplina do RM ──');
    p('  Pode ser renomeação no RM, ou título montado com outro critério.');
    for (const r of renomeadas.slice(0, 10)) {
      p(`  ${r.IDTURMADISC}: RM="${r.NOMEDISC}"`);
      p(`      Toddle="${tituloPorTd.get(r.IDTURMADISC)}"`);
    }
    if (renomeadas.length > 10) p(`  … e ${renomeadas.length - 10} outra(s)`);
  }

  p('');
  p('══════════════════════════════════════════════════════════════════');
  if (precisaAcao.length === 0) {
    p('  Sem deriva que exija ação.');
  } else {
    p(`  ${precisaAcao.length} item(ns) exigem decisão. Criar turma no Toddle não`);
    p('  tem DELETE (só archive), então nada é feito automaticamente aqui.');
  }
  p('══════════════════════════════════════════════════════════════════');
  p('');
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'reconciliar:turmas falhou');
    process.exitCode = 1;
  })
  .finally(() => pgPool.end());
