import { env, logger, tenantConfig } from '@rm-toddle/config';
import { pgPool } from './pool';

/** Config da escola atendida por este processo. Ver packages/config/src/tenantConfig.ts. */
const cfg = tenantConfig;

/**
 * Registro durável de EXECUÇÃO, na tabela `job_run`.
 *
 * ─── O PROBLEMA QUE ISTO RESOLVE ────────────────────────────────────────────
 *
 * Em 20/08/2026 eu tentei DUAS vezes escrever um monitor que respondesse "o job
 * rodou bem?" e errei as duas condições, pelo mesmo motivo de fundo: **tentei
 * inferir saúde do run a partir de efeito colateral em dado de negócio.**
 *
 *   1. "o contador de concluídos do BullMQ subiu" — inválido. O BullMQ PODA esse
 *      conjunto, então o número CAI (21 -> 3) em vez de crescer. Ele mede
 *      retenção, não atividade.
 *   2. "o max(updated_at) do de-para virou hoje" — inválido para professores.
 *      Num run sem professor novo nada é escrito e o timestamp não se move,
 *      apesar de o job ter concluído com sucesso. "Nada mudou" é o caso NORMAL.
 *
 * Efeito colateral não serve porque o resultado correto muitas vezes é "nada".
 * A saída é registrar o RUN, não o efeito.
 *
 * ─── POR QUE TABELA PRÓPRIA (correção de 21/08/2026) ────────────────────────
 *
 * A primeira versão disto usava `operation` (migration 006), porque o CHECK dela
 * já aceitava `executing`/`succeeded`/`failed` e "não precisou de migration".
 * Foi conveniência, e virou dívida na mesma semana: `operation` foi desenhada
 * para operação APROVÁVEL — máquina de estados, com `criado_por` e a tabela
 * `approval` referenciando-a.
 *
 * Execução é outra coisa: um EVENTO, append-only. A migration 011 separou, e a
 * janela foi essa porque as duas tabelas estavam vazias. Depois do writer,
 * `operation` passa a ser trilha de auditoria de escrita no ERP de um cliente, e
 * mexer nela deixa de ser refactor.
 *
 * ─── O QUE NÃO ENTRA AQUI ───────────────────────────────────────────────────
 *
 * `audit_event` continua com 0 linhas, de propósito. Uma linha por ALUNO por run
 * seriam 255 x 4 por dia de "sucesso" — volume, custo e discussão de LGPD sem
 * responder nenhuma pergunta que alguém tenha. Uma linha por RUN responde.
 */

/** Estados que este módulo usa (o CHECK de job_run aceita exatamente estes três). */
type EstadoRun = 'executing' | 'succeeded' | 'failed';

let tenantIdCache: string | null = null;
/**
 * Mesma resolução do idMappingRepository, e pelo mesmo motivo: sem tenant
 * resolvido a linha não pode ser gravada, porque `job_run.tenant_id` é NOT NULL
 * e um run sem dono não é auditável.
 */
async function tenantId(): Promise<string> {
  if (tenantIdCache) return tenantIdCache;
  const { rows } = await pgPool.query<{ id: string }>(
    "SELECT id FROM tenant WHERE slug = $1 AND status = 'active'",
    [cfg.slug],
  );
  if (!rows[0]) {
    throw new Error(
      `TENANT_SLUG="${cfg.slug}" não existe (ou está suspenso) na tabela tenant.`,
    );
  }
  const resolvido = rows[0].id;
  tenantIdCache = resolvido;
  return resolvido;
}

export interface AbrirRunArgs {
  /** `students.extract` | `staff.sync` — o `tipo` da operação. */
  tipo: string;
  /** Chave única do run. Use o jobId do BullMQ: é único por disparo do cron. */
  chave: string;
  configVersion: string;
  /** Contexto do run: trigger, escopo, o que for útil para explicar depois. */
  payload: Record<string, unknown>;
  /**
   * Semente do `resultado`. Serve para o que precisa estar lá desde o início —
   * hoje só `emEscopo`, que é o que `ultimaContagemEmEscopo` lê para alimentar a
   * guarda de desvio do run seguinte. Sem a semente, `emEscopo` só existiria no
   * `payload` e a guarda nunca teria histórico com que comparar.
   */
  resultadoInicial?: Record<string, unknown>;
}

/**
 * Abre a linha do run em `executing`.
 *
 * Idempotente por `(tenant_id, idempotency_key)`: o retry do BullMQ reusa o mesmo
 * jobId, e reabrir o run em vez de duplicar é o comportamento certo — a tentativa
 * 2 é o mesmo run, não outro.
 *
 * Devolve o id da linha, ou `null` se não deu para gravar. **Nunca lança**: um
 * problema no registro de execução não pode derrubar a execução. É a mesma regra
 * do heartbeat, pelo mesmo motivo.
 */
export async function abrirRun(args: AbrirRunArgs): Promise<string | null> {
  try {
    const { rows } = await pgPool.query<{ id: string }>(
      `INSERT INTO job_run (tenant_id, tipo, estado, payload, resultado, config_version, chave)
       VALUES ($1, $2, 'executing', $3, $4, $5, $6)
       ON CONFLICT (tenant_id, chave) DO UPDATE
         SET estado     = 'executing',
             payload    = EXCLUDED.payload,
             resultado  = EXCLUDED.resultado,
             updated_at = now()
       RETURNING id`,
      [
        await tenantId(),
        args.tipo,
        JSON.stringify(args.payload),
        JSON.stringify(args.resultadoInicial ?? {}),
        args.configVersion,
        args.chave,
      ],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tipo: args.tipo, chave: args.chave },
      'Não foi possível abrir o registro de run — a execução segue, mas sem rastro durável',
    );
    return null;
  }
}

/** Fecha o run. `nunca lança`, mesma regra do abrirRun. */
export async function fecharRun(
  id: string | null,
  estado: Exclude<EstadoRun, 'executing'>,
  resultado: Record<string, unknown>,
): Promise<void> {
  if (!id) return;
  try {
    await pgPool.query(
      `UPDATE job_run SET estado = $2, resultado = $3, updated_at = now() WHERE id = $1`,
      [id, estado, JSON.stringify(resultado)],
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, id, estado },
      'Não foi possível fechar o registro de run',
    );
  }
}

export interface ContadoresLote {
  created: number;
  updated: number;
  unarchived: number;
  failed: number;
}

export interface RunFechado {
  /** `true` quando ESTE lote foi o último — só então o run tem veredito. */
  completo: boolean;
  estado: 'succeeded' | 'failed';
  resultado: Record<string, unknown>;
}

/**
 * Acumula os contadores de um lote no run e, se foi o último, devolve o veredito.
 *
 * ─── POR QUE ACUMULAR EM VEZ DE FECHAR NO EXTRACT ───────────────────────────
 *
 * O sync de aluno tem duas fases: o `extract` lê o RM e faz fan-out em N lotes,
 * e cada `upsert-batch` escreve no Toddle. Se o run fosse declarado bem-sucedido
 * ao fim do extract, o heartbeat mentiria: leitura boa e escrita quebrada
 * pingaria sucesso. O run só é sucesso quando o último lote fecha.
 *
 * ─── A ARITMÉTICA É NO POSTGRES, DE PROPÓSITO ───────────────────────────────
 *
 * `SET resultado = ... (resultado->>'x')::int + $n` lê o valor ANTERIOR da linha
 * dentro do próprio UPDATE, então dois lotes concorrentes não se sobrescrevem.
 * Hoje a concorrência do worker é 1 e isso não morde, mas ler-modificar-escrever
 * no TypeScript viraria bug no dia em que alguém subir a concorrência — e seria
 * um bug de contador, do tipo que ninguém percebe.
 *
 * ─── LOTE QUE ESGOTA AS TENTATIVAS ──────────────────────────────────────────
 *
 * Se um lote falhar de vez, ele lança e vai para a DLQ sem passar por aqui: o run
 * fica **preso em `executing`**. Isso é informação, não defeito — nenhum ping de
 * sucesso é enviado, e o monitor externo alerta por silêncio. Run em `executing`
 * com `created_at` velho é a assinatura de "morreu no meio".
 */
export async function acumularLote(
  runChave: string,
  c: ContadoresLote,
): Promise<RunFechado | null> {
  try {
    const { rows } = await pgPool.query<{ resultado: Record<string, unknown>; esperados: number | null }>(
      `UPDATE job_run
          SET resultado = COALESCE(resultado, '{}'::jsonb) || jsonb_build_object(
                'created',          COALESCE((resultado->>'created')::int, 0)          + $3::int,
                'updated',          COALESCE((resultado->>'updated')::int, 0)          + $4::int,
                'unarchived',       COALESCE((resultado->>'unarchived')::int, 0)       + $5::int,
                'failed',           COALESCE((resultado->>'failed')::int, 0)           + $6::int,
                'lotesConcluidos',  COALESCE((resultado->>'lotesConcluidos')::int, 0)  + 1
              ),
              updated_at = now()
        WHERE tenant_id = $1 AND chave = $2 AND estado = 'executing'
        RETURNING resultado, (payload->>'lotesEsperados')::int AS esperados`,
      [await tenantId(), runChave, c.created, c.updated, c.unarchived, c.failed],
    );

    const linha = rows[0];
    if (!linha) return null; // run não encontrado ou já fechado

    const concluidos = Number(linha.resultado?.lotesConcluidos ?? 0);
    const esperados = linha.esperados;
    if (esperados === null || concluidos < esperados) return null; // ainda faltam lotes

    const falhas = Number(linha.resultado?.failed ?? 0);
    const estado = falhas > 0 ? 'failed' : 'succeeded';
    await fecharRunPorChave(runChave, estado, linha.resultado);
    return { completo: true, estado, resultado: linha.resultado };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, runChave },
      'Não foi possível acumular o lote no registro de run',
    );
    return null;
  }
}

/** Fecha o run pela chave de idempotência, sem precisar do UUID. */
export async function fecharRunPorChave(
  chave: string,
  estado: Exclude<EstadoRun, 'executing'>,
  resultado: Record<string, unknown>,
): Promise<void> {
  try {
    await pgPool.query(
      `UPDATE job_run SET estado = $3, resultado = $4, updated_at = now()
        WHERE tenant_id = $1 AND chave = $2`,
      [await tenantId(), chave, estado, JSON.stringify(resultado)],
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message, chave, estado }, 'Não foi possível fechar o run');
  }
}

/**
 * Contagem em escopo do último run BEM-SUCEDIDO do mesmo tipo.
 *
 * Alimenta a guarda de desvio. Devolve `null` quando não há histórico — e aí a
 * guarda não opina, porque o primeiro run não tem com o que comparar.
 */
export async function ultimaContagemEmEscopo(tipo: string): Promise<number | null> {
  try {
    const { rows } = await pgPool.query<{ n: string | null }>(
      `SELECT (resultado->>'emEscopo') AS n
         FROM job_run
        WHERE tenant_id = $1 AND tipo = $2 AND estado = 'succeeded'
          AND resultado ? 'emEscopo'
        ORDER BY created_at DESC
        LIMIT 1`,
      [await tenantId(), tipo],
    );
    const bruto = rows[0]?.n;
    if (bruto === undefined || bruto === null) return null;
    const n = Number(bruto);
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    logger.warn({ err: (err as Error).message, tipo }, 'Não foi possível ler a contagem anterior');
    return null;
  }
}

export interface DesvioAvaliado {
  aborta: boolean;
  anterior: number | null;
  atual: number;
  desvioPct: number | null;
  motivo?: string;
}

/**
 * A guarda de desvio de contagem.
 *
 * ─── O MODO DE FALHA QUE ELA COBRE ──────────────────────────────────────────
 *
 * O sync é COMPLETO e idempotente, e isso é uma virtude — foi o que permitiu
 * recuperar 8 dias parados sem reprocessar nada. Mas tem um lado afiado: se o RM
 * servir uma cópia ANTIGA da base, o sync sobrescreve alegremente os alunos no
 * Toddle com dado velho, reporta `failed=0` e não emite um único log de erro.
 *
 * Não é hipótese: a base do RM foi trocada por cópia entre 13 e 15/08/2026. É o
 * modo de falha mais perigoso que sobrou no sistema, porque é silencioso E
 * destrutivo — as duas coisas ao mesmo tempo.
 *
 * A guarda é grosseira de propósito: compara só a contagem em escopo com a do
 * último run bem-sucedido. Não tenta ser inteligente; tenta ser difícil de
 * quebrar. Matrícula e transferência mexem a contagem em unidades; base trocada
 * mexe em dezenas.
 *
 * ─── FALHA PARA QUAL LADO? ──────────────────────────────────────────────────
 *
 * Para o lado de NÃO ESCREVER. Um run abortado é recuperável — o próximo cron
 * roda em horas, e o sync completo se auto-cura. Sobrescrever 255 alunos com
 * dado de outra base não é: aluno arquivado no Toddle não volta por GET, e turma
 * errada no boletim é visível para a família.
 *
 * Se o desvio for legítimo (a escola matriculou 40 alunos de uma vez), a saída é
 * subir `SYNC_DESVIO_MAX_PCT` ou rodar o sync à mão uma vez — as duas
 * conscientes, que é exatamente o que se quer de uma decisão dessas.
 */
export function avaliarDesvio(anterior: number | null, atual: number): DesvioAvaliado {
  if (env.SYNC_DESVIO_MAX_PCT === 0) {
    return { aborta: false, anterior, atual, desvioPct: null, motivo: 'guarda desligada' };
  }
  if (anterior === null) {
    return { aborta: false, anterior, atual, desvioPct: null, motivo: 'sem run anterior' };
  }
  if (anterior === 0) {
    // Dividir por zero não diz nada. Sair de 0 para qualquer coisa é a
    // recuperação normal de um ambiente novo, não um desvio.
    return { aborta: false, anterior, atual, desvioPct: null, motivo: 'anterior era zero' };
  }

  const desvioPct = (Math.abs(atual - anterior) / anterior) * 100;
  const aborta = desvioPct > env.SYNC_DESVIO_MAX_PCT;
  return {
    aborta,
    anterior,
    atual,
    desvioPct: Number(desvioPct.toFixed(1)),
    motivo: aborta
      ? `contagem em escopo variou ${desvioPct.toFixed(1)}% (${anterior} -> ${atual}), ` +
        `acima do teto de ${env.SYNC_DESVIO_MAX_PCT}%`
      : undefined,
  };
}
