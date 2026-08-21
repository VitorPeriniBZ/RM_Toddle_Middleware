import { Job } from 'bullmq';
import { configVersion, heartbeat, logger } from '@rm-toddle/config';
import { abrirRun, fecharRunPorChave } from '@rm-toddle/db';
import { sincronizarProfessores } from '../../sync/professores';
import type { ResumoSyncProfessores } from '../../sync/professores';

/** `tipo` da linha em `operation`. Ver a nota em studentSync.processor.ts. */
const RUN_TIPO_PROFESSORES = 'staff.sync';

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

  // Fase única, então a chave do run é o próprio jobId — que no cron é
  // `repeat:staff-sync-nightly:<millis>`, único por disparo. Não precisa do
  // saneamento que o de aluno faz, porque aqui a chave não vira jobId de lote.
  const chave = job.id ?? `staff-${Date.now()}`;
  await abrirRun({
    tipo: RUN_TIPO_PROFESSORES,
    chave,
    configVersion: configVersion(),
    payload: { jobId: job.id },
  });

  let resumo: ResumoSyncProfessores;
  try {
    resumo = await sincronizarProfessores({ executar: true });
  } catch (err) {
    // Falha na LEITURA (RM fora, credencial, Sentença) nunca chegava a `resumo`.
    // Sem isto o run ficaria preso em `executing` sem dizer por quê.
    await fecharRunPorChave(chave, 'failed', { erro: (err as Error).message });
    throw err;
  }

  await job.updateProgress({ fase: 'concluido', ...resumo, falhas: resumo.falhas.length });

  // O resultado é gravado nos DOIS caminhos: um sync que vinculou 2 e falhou 1
  // precisa deixar registrado o que fez, não só que falhou.
  const resultado: Record<string, unknown> = {
    mapeados: resumo.mapeados,
    criados: resumo.criados,
    vinculados: resumo.vinculados,
    pulados_sem_email: resumo.pulados_sem_email,
    turmas_gerenciadas: resumo.turmas_gerenciadas,
    turmas_nao_mapeadas: resumo.turmas_nao_mapeadas,
    falhas: resumo.falhas.length,
  };

  if (resumo.falhas.length > 0) {
    log.error({ falhas: resumo.falhas }, 'Sync de professores terminou com falhas');
    await fecharRunPorChave(chave, 'failed', { ...resultado, detalheFalhas: resumo.falhas });
    throw new Error(
      `${resumo.falhas.length} falha(s) no sync de professores: ` +
        resumo.falhas.map((f) => `${f.o_que} ${f.alvo} (${f.erro})`).join('; '),
    );
  }

  await fecharRunPorChave(chave, 'succeeded', resultado);
  // O ping de SUCESSO vive aqui, não no evento `completed` do worker: só neste
  // ponto "o run foi bem" é uma afirmação honesta. A falha é pingada no worker,
  // que sabe se as tentativas esgotaram.
  await heartbeat.professores('sucesso', resultado);

  log.info(resumo, 'Sync de professores concluído');
  return resumo;
}
