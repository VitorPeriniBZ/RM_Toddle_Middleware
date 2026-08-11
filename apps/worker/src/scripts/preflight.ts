import { cronDoProfessorEfetivo, env, isRmSoapConfigured, logger } from '@rm-toddle/config';


/**
 * Verifica, ANTES de o deploy terminar, se este ambiente tem o que os jobs
 * agendados precisam. Roda no serviço `init` do docker-compose.coolify.yml.
 *
 *   npm run preflight
 *
 * ─── POR QUE ISTO EXISTE ────────────────────────────────────────────────────
 *
 * Em 10/08/2026 `RM_SENTENCA_TURMADISC` foi adicionada no `.env` local e esquecida
 * em produção. O Zod NÃO reclamou — a variável é `.optional()`, porque um tenant
 * que não sincroniza professor legitimamente não precisa dela. O deploy passou
 * verde. Às 03:30 o `staff.sync` disparou, morreu nas 3 tentativas e foi para a
 * DLQ. Ficou quebrado por um dia, porque ninguém olha log às 3h.
 *
 * A lacuna é exatamente esta: **variável opcional no schema, obrigatória em
 * runtime para o job que está agendado.** O Zod não tem como saber quais jobs
 * você agendou; este script sabe.
 *
 * ─── POR QUE NÃO É O `comparar-env.sh` ──────────────────────────────────────
 *
 * Aquele compara o `.env` da máquina do dev com o container de produção, e o
 * deploy não tem acesso ao laptop de ninguém. Ele continua sendo a ferramenta
 * certa PARA O DEV, antes de subir. Este aqui pergunta outra coisa: "este
 * ambiente, sozinho, consegue rodar o que prometeu rodar?"
 *
 * ─── SEM CHAMADA DE REDE, DE PROPÓSITO ──────────────────────────────────────
 *
 * Não valida token do Toddle nem conectividade com o RM. Deploy que depende de
 * API de terceiro para terminar é deploy que falha quando o terceiro cai. Os
 * jobs já fazem `assertTargetOrganization()` na execução, que é onde importa.
 */

interface Checagem {
  nome: string;
  ok: boolean;
  detalhe: string;
  /** `false` = avisa e segue; `true` = derruba o deploy. */
  fatal: boolean;
}

function checar(): Checagem[] {
  const c: Checagem[] = [];

  // --- o que TODO sync para o Toddle precisa ---------------------------------
  c.push({
    nome: 'wsConsultaSQL configurado',
    ok: isRmSoapConfigured,
    detalhe: isRmSoapConfigured
      ? `${env.RM_WS_BASEURL}`
      : 'faltam RM_WS_BASEURL / RM_WS_USER / RM_WS_PASS — nenhuma leitura do RM funciona',
    fatal: true,
  });

  c.push({
    nome: 'RM_CODPERLET (ano letivo)',
    ok: Boolean(env.RM_CODPERLET),
    detalhe: env.RM_CODPERLET
      ? String(env.RM_CODPERLET)
      : 'ausente — as Sentenças exigem o período letivo e falham em runtime',
    fatal: true,
  });

  /**
   * `SOURCE_ID_PREFIX` tem `.default('')` no schema, então o Zod aceita vazio.
   * Em produção, vazio é CATASTRÓFICO: a busca por `sourceId` no Toddle não acha
   * ninguém e o middleware cria 253 alunos DUPLICADOS — e aluno no Toddle só
   * arquiva, nunca apaga. Ter default não significa que o default serve.
   */
  const prefixoOk = env.NODE_ENV !== 'production' || env.SOURCE_ID_PREFIX.trim() !== '';
  c.push({
    nome: 'SOURCE_ID_PREFIX não vazio (produção)',
    ok: prefixoOk,
    detalhe: prefixoOk
      ? `"${env.SOURCE_ID_PREFIX}"`
      : 'VAZIO em produção — a busca por sourceId não acharia ninguém e o sync ' +
        'CRIARIA alunos duplicados, irreversivelmente',
    fatal: true,
  });

  // --- sync de ALUNO: está agendado, então é obrigatório ---------------------
  c.push({
    nome: `RM_SENTENCA_STUDENTS (sync de aluno, cron "${env.STUDENTS_SYNC_CRON}")`,
    ok: Boolean(env.RM_SENTENCA_STUDENTS),
    detalhe: env.RM_SENTENCA_STUDENTS ?? 'ausente — o job students.extract falha em runtime',
    fatal: true,
  });

  // --- sync de PROFESSOR: idem. Foi aqui que doeu ----------------------------
  c.push({
    nome: `RM_SENTENCA_TURMADISC (sync de professor, cron "${cronDoProfessorEfetivo()}")`,
    ok: Boolean(env.RM_SENTENCA_TURMADISC),
    detalhe:
      env.RM_SENTENCA_TURMADISC ??
      'ausente — o job staff.sync falha em runtime e vai para a DLQ. ' +
        'Foi exatamente isto em 10/08/2026: opcional no Zod, obrigatória para o job agendado',
    fatal: true,
  });

  // --- escopo e destino ------------------------------------------------------
  c.push({
    nome: 'TODDLE_ORG_ID',
    ok: Boolean(env.TODDLE_ORG_ID),
    detalhe: env.TODDLE_ORG_ID || 'ausente',
    fatal: true,
  });

  c.push({
    nome: 'RM_CODFILIAL (escopo de campus)',
    ok: Boolean(env.RM_CODFILIAL),
    detalhe: env.RM_CODFILIAL,
    fatal: true,
  });

  // --- avisos: não derrubam o deploy ----------------------------------------
  c.push({
    nome: 'RM_TURMAS_IGNORADAS',
    ok: Boolean(env.RM_TURMAS_IGNORADAS?.trim()),
    detalhe: env.RM_TURMAS_IGNORADAS?.trim()
      ? env.RM_TURMAS_IGNORADAS
      : 'vazia — turmas de conveniência de lançamento (na EAV, "IG") vão aparecer ' +
        'como deriva na reconciliação. Correto para quem não tem essa convenção',
    fatal: false,
  });

  c.push({
    nome: 'TODDLE_DEFAULT_YEAR_GROUP_ID',
    ok: Boolean(env.TODDLE_DEFAULT_YEAR_GROUP_ID),
    detalhe: env.TODDLE_DEFAULT_YEAR_GROUP_ID
      ? env.TODDLE_DEFAULT_YEAR_GROUP_ID
      : 'vazio (fail-closed) — aluno de turma sem de-para vai para a DLQ em vez de ' +
        'entrar num grupo genérico. É o comportamento desejado, mas alguém tem de olhar a DLQ',
    fatal: false,
  });

  return c;
}

const checagens = checar();
const falhas = checagens.filter((c) => !c.ok && c.fatal);
const avisos = checagens.filter((c) => !c.ok && !c.fatal);

for (const c of checagens.filter((x) => x.ok)) {
  logger.info({ check: c.nome, valor: c.detalhe }, 'preflight ok');
}
for (const c of avisos) {
  logger.warn({ check: c.nome }, `preflight AVISO: ${c.detalhe}`);
}

if (falhas.length > 0) {
  for (const c of falhas) {
    logger.error({ check: c.nome }, `preflight FALHOU: ${c.detalhe}`);
  }
  logger.error(
    { falhas: falhas.length, avisos: avisos.length },
    `Preflight reprovou ${falhas.length} checagem(ns) — o deploy para aqui. ` +
      'Corrija as variáveis no Coolify e redeploye; salvar não troca o env de um container já rodando. ' +
      'Do lado do dev, `./scripts/comparar-env.sh` mostra a divergência antes de subir.',
  );
  process.exit(1);
}

logger.info(
  { checagens: checagens.length, avisos: avisos.length },
  'Preflight aprovado — o ambiente tem o que os jobs agendados precisam',
);
