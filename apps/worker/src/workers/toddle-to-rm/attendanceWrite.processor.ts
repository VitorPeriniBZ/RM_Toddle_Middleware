import type { Job } from 'bullmq';
import { env, logger, tenantConfig } from '@rm-toddle/config';
import { executarEscritaFrequencia } from './frequenciaWrite';

const cfg = tenantConfig;

/**
 * Job agendado da via de volta: frequência lançada no Toddle -> falta no RM.
 *
 * Chama EXATAMENTE o mesmo caminho da CLI (`npm run escrever:frequencia`), com
 * os quatro guardas ativos. Não há atalho aqui: a única coisa deste projeto que
 * altera o registro acadêmico de uma escola não pode ter um caminho "de job" e
 * outro "de gente".
 *
 * ─── A JANELA É CALCULADA AQUI, NÃO NO SCHEDULER ────────────────────────────
 *
 * `ATTENDANCE_WRITE_DIAS` (default 7) dias para trás, até hoje. Não é 1:
 * professor corrige chamada dias depois, e a decisão de escrita é idempotente
 * por desenho — uma janela já escrita volta como NADA_A_FAZER e não gasta
 * chamada. O custo de olhar 7 dias é uma leitura a mais; o de olhar 1 é perder
 * toda correção retroativa, em silêncio.
 *
 * Datas em horário de São Paulo, não UTC: às 18:00 BRT já é dia seguinte em UTC,
 * e a janela pularia o dia que acabou de ser lançado.
 *
 * ─── O GATE DE APROVAÇÃO NUM JOB SEM GENTE ──────────────────────────────────
 *
 * Se o teto de volume pedir aprovação, o run PARA e espera um humano — e isso
 * está certo, inclusive aqui. Num dia normal o veredito é AUTORIZADO, porque já
 * existe histórico de escrita; o gate só dispara em anomalia, que é exatamente
 * quando ninguém deveria escrever no automático.
 *
 * É por isso que o cron default é 18:00 e não de madrugada: se o run travar
 * esperando decisão, há alguém acordado para tomá-la.
 */
export async function processAttendanceWrite(job: Job): Promise<{
  janela: { de: string; ate: string };
  dias: number;
}> {
  const dias = env.ATTENDANCE_WRITE_DIAS;
  const { de, ate } = janelaEmSaoPaulo(dias);

  logger.info(
    { jobId: job.id, jobName: job.name, janela: `${de} → ${ate}`, dias, tenant: cfg.slug },
    'Escrita agendada de frequência no RM',
  );

  await executarEscritaFrequencia({ de, ate, executar: true, quem: 'cron' });

  return { janela: { de, ate }, dias };
}

/**
 * Janela [hoje-(dias-1), hoje] no fuso de São Paulo, como "YYYY-MM-DD".
 *
 * `en-CA` porque é o locale que formata como ISO (`2026-08-25`) — converter à
 * mão com getFullYear/getMonth daria a data do fuso do CONTAINER, que roda em
 * UTC. Um dia de erro aqui não erra o horário: erra qual aula foi lançada.
 */
function janelaEmSaoPaulo(dias: number): { de: string; ate: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });
  const agora = Date.now();
  return {
    de: fmt.format(new Date(agora - (dias - 1) * 86_400_000)),
    ate: fmt.format(new Date(agora)),
  };
}
