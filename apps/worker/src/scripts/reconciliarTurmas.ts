import { logger, tenantConfig } from '@rm-toddle/config';
import { pgPool } from '@rm-toddle/db';
import {
  EXIGEM_DECISAO,
  LeituraDeTurmasQuebrada,
  exigemDecisao,
  reconciliarTurmas,
  type RelatorioDeTurmas,
  type Situacao,
} from '../services/reconciliarTurmas';

/** Config da escola atendida por este processo. */
const cfg = tenantConfig;

/**
 * Compara as turma-disciplina do RM com o de-para e relata a DERIVA.
 * SOMENTE LEITURA — não cria, não arquiva, não altera nada.
 *
 *   npm run reconciliar:turmas
 *   npm run reconciliar:turmas -- --tudo    # inclui as sem aluno
 *
 * ─── POR QUE ISTO EXISTE ────────────────────────────────────────────────────
 *
 * Os 186 `COURSE` vieram de uma carga manual e **nada os atualiza**. O de-para
 * de turma é um retrato, não uma sincronização: toda turma-disciplina criada
 * depois fica invisível para a integração. Foi assim que a `1714` ficou de fora
 * com 60 faltas lançadas — e só apareceu por acidente, ao cruzar frequência.
 *
 * ─── A REGRA NÃO MORA MAIS AQUI ─────────────────────────────────────────────
 *
 * A comparação vive em `services/reconciliarTurmas.ts`, que é o MESMO código do
 * job `courses.sync`. Este arquivo só imprime.
 *
 * A duplicação não era teórica: enquanto as duas cópias existiram, a do serviço
 * ganhou o conserto do `SUMIU_DO_RM` (que comparava chave natural contra um
 * de-para ainda gravado em IDTURMADISC, reportando as mesmas 186 turmas como OK
 * E como sumidas) e esta continuou errada.
 */
function p(s = ''): void {
  // eslint-disable-next-line no-console
  console.log(s);
}

function imprimir(r: RelatorioDeTurmas, tudo: boolean): void {
  const por = (s: Situacao) => r.achados.filter((a) => a.situacao === s);

  p('');
  p('══════════════════════════════════════════════════════════════════');
  p('  Reconciliação de turma-disciplina — RM × de-para');
  p('  SOMENTE LEITURA. Nada foi criado, arquivado ou alterado.');
  p('══════════════════════════════════════════════════════════════════');
  p(`  campus ${cfg.rm.escopo.filiais}   coligada ${cfg.rm.escopo.coligada}   IDPERLET ${r.idPerlet}`);
  p('');
  p(`  turma-disciplina no RM (campus)        ${r.lidasDoRm}`);
  p(`  do período letivo corrente             ${r.doPeriodoCorrente}`);
  p(`  mapeamentos COURSE ativos              ${r.mapeadasAtivas}`);
  p(`  mapeamentos COURSE arquivados          ${r.mapeadasArquivadas}`);
  p('');
  p('── situação ──────────────────────────────────────────────────────');
  const ordem: Situacao[] = [
    'OK', 'NOVA_COM_ALUNOS', 'INATIVADA_NO_RM', 'REATIVADA_NO_RM', 'SUMIU_DO_RM', 'NOVA_SEM_ALUNOS',
  ];
  for (const s of ordem) {
    const n = por(s).length;
    if (n === 0) continue;
    p(`  ${EXIGEM_DECISAO.includes(s) ? '⚠' : ' '} ${s.padEnd(20)} ${String(n).padStart(4)}`);
  }

  // A conta do de-para, SEMPRE — não só quando quebra. Um número que só aparece
  // no erro não ensina ninguém a lê-lo.
  const c = r.contaDoDePara;
  p('');
  p(`  conta do de-para: ${c.classificadas} classificada(s) de ${c.mapeadasAtivas} mapeada(s) ativa(s) ${c.fecha ? '✓' : '✗ NÃO FECHA'}`);
  if (!c.fecha) {
    p('      Uma turma mapeada foi classificada duas vezes, ou nenhuma. O resto');
    p('      deste relatório não é confiável — investigue antes de agir.');
  }
  if (r.semSinalDeAlunos) {
    p('');
    p('  ⚠ sem o sinal de alunos por turma: nenhuma turma nova foi classificada');
    p('    como "sem aluno", porque afirmar isso sem medir esconderia justamente');
    p('    a turma que este relatório existe para achar.');
  }

  const precisaAcao = exigemDecisao(r);
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

  if (r.renomeadas.length) {
    p('');
    p('── ⚠ título no Toddle não contém mais o nome da disciplina do RM ──');
    p('  Pode ser renomeação no RM, ou título montado com outro critério.');
    for (const x of r.renomeadas.slice(0, 10)) {
      p(`  ${x.idTurmaDisc}: RM="${x.noRm}"`);
      p(`      Toddle="${x.noToddle}"`);
    }
    if (r.renomeadas.length > 10) p(`  … e ${r.renomeadas.length - 10} outra(s)`);
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

async function main(): Promise<void> {
  const tudo = process.argv.includes('--tudo');
  imprimir(await reconciliarTurmas(), tudo);
}

main()
  .catch((error) => {
    if (error instanceof LeituraDeTurmasQuebrada) {
      p('');
      p('  A LEITURA está quebrada — "sem deriva" seria mentira, então nada foi relatado.');
      p(`  ${error.message}`);
      p(`  Como resolver: ${error.comoResolver}`);
      p('');
    } else {
      logger.error({ err: error }, 'reconciliar:turmas falhou');
    }
    process.exitCode = 1;
  })
  .finally(() => pgPool.end());
