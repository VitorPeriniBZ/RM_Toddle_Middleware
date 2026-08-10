import { Job } from 'bullmq';
import { logger } from '@rm-toddle/config';
import { sincronizarProfessores } from '../../sync/professores';
import type { ResumoSyncProfessores } from '../../sync/professores';

/**
 * Job `staff.sync` — sincroniza professor e vínculo turma-disciplina↔docente.
 *
 * Sem fan-out, ao contrário do de aluno: 35 professores e ~200 turma-disciplina,
 * com poucos registros escritos por noite. Fatiar traria complexidade sem ganho.
 *
 * ─── ESTE JOB ESCREVE ───────────────────────────────────────────────────────
 *
 * Roda com `executar: true`. O que ele pode escrever é limitado pelo desenho da
 * sincronização, não pela sorte: cria staff só com e-mail vindo do RM, e o
 * vínculo é reversível. O que é irreversível e ambíguo (professor sem e-mail,
 * vínculo sobrando, professor que saiu) ele NÃO toca — relata.
 *
 * ─── FALHA PARCIAL NÃO É SUCESSO ────────────────────────────────────────────
 *
 * Se algum registro falhar, o job LANÇA depois de terminar os outros. Assim o
 * retry do BullMQ acontece (a sincronização é idempotente, então repetir é
 * seguro) e, esgotadas as tentativas, o payload vai para a DLQ em vez de a noite
 * passar como bem-sucedida com metade do trabalho feito.
 */
export async function processStaffSync(job: Job): Promise<ResumoSyncProfessores> {
  const log = logger.child({ jobId: job.id, jobName: job.name });
  log.info('Sync de professores iniciado');

  const resumo = await sincronizarProfessores({ executar: true });

  await job.updateProgress({ fase: 'concluido', ...resumo, falhas: resumo.falhas.length });

  if (resumo.falhas.length > 0) {
    log.error({ falhas: resumo.falhas }, 'Sync de professores terminou com falhas');
    throw new Error(
      `${resumo.falhas.length} falha(s) no sync de professores: ` +
        resumo.falhas.map((f) => `${f.o_que} ${f.alvo} (${f.erro})`).join('; '),
    );
  }

  log.info(resumo, 'Sync de professores concluído');
  return resumo;
}
