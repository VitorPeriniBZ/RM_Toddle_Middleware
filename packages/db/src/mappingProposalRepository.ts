import { logger, tenantConfig } from '@rm-toddle/config';
import { pgPool } from './pool';
import { registrarEvento, type Ator } from './auditRepository';
import { PAPEIS_QUE_APROVAM, quantosPodemAprovar } from './accessRepository';
import { ENTITY_TYPES, type EntityType, type IdMapping } from './idMappingRepository';

/** Config da escola atendida por este processo. */
const cfg = tenantConfig;

/**
 * MUDANÇA DE VÍNCULO como operação aprovável — nunca como CRUD.
 *
 * ─── POR QUE A TELA NÃO ESCREVE EM `id_mapping` ─────────────────────────────
 *
 * Um vínculo errado não é erro de tela: é nota ou falta gravada na turma, no
 * aluno ou na etapa errada do registro acadêmico — e o RM já tem ~10 mil notas e
 * 14,6 mil faltas lançadas à mão por humanos. O `configVersion` não protege
 * contra isso: ele cobre escopo e destino, e mapeamento é DADO, não configuração.
 * Editar um vínculo entre o extract e o load muda o destino de fato, e o hash não
 * percebe.
 *
 * Então a tela PROPÕE. A proposta nasce em `operation` (migration 006), com
 * `payload` congelado e `source_snapshot` guardando o que a linha era no momento
 * da proposta. Aprovar é um segundo passo, que revalida o snapshot antes de
 * gravar: se a linha mudou no meio (outro sync, outra pessoa), a aprovação perde
 * validade e ninguém escreve.
 *
 * ─── AS TRÊS FORMAS, E POR QUE NÃO EXISTE UMA QUARTA ────────────────────────
 *
 *   vincular    o `rm_code` não tem linha: cria.
 *   revincular  a linha existe e passa a apontar para outro `toddle_id`.
 *   arquivar    tira de escopo com `state='archived'`, preservando a linha.
 *
 * Não existe `apagar`. O `toddle_id` guardado aqui é o único caminho de volta
 * para um registro arquivado no Toddle — o GET /students não devolve arquivado
 * nem filtrando por `sourceId` —, e apagar 186 linhas em 31/07/2026 destruiu
 * exatamente esse handle. A migration 018 passou a recusar DELETE no banco.
 *
 * ─── O HISTÓRICO DE UM `revincular` MORA NA AUDITORIA ───────────────────────
 *
 * A migration 006 criou `superseded_by` para preservar a cadeia em vez de
 * sobrescrever, e a intenção é boa — mas ela não se aplica aqui: a chave única é
 * `(tenant_id, entity_type, rm_code, target_instance_key)` e NÃO tem predicado de
 * estado, então duas linhas para o mesmo `rm_code` no mesmo destino não podem
 * coexistir nem com uma delas arquivada. Revincular é, necessariamente, UPDATE
 * do `toddle_id`.
 *
 * Consequência que precisa estar dita em voz alta: o valor anterior sobrevive
 * SÓ em `audit_event`, no campo `antes`. É por isso que a auditoria aqui é
 * transacional e obrigatória, e não best-effort — sem ela, o vínculo antigo
 * desaparece sem rastro.
 */

export const FORMAS = ['vincular', 'revincular', 'arquivar'] as const;
export type FormaDeProposta = (typeof FORMAS)[number];

/** `operation.tipo` das propostas. Prefixo separa do gate de volume da escrita. */
export const TIPO_OPERACAO = 'mapping.vinculo';

export interface PropostaDeVinculo {
  forma: FormaDeProposta;
  entityType: EntityType;
  rmCode: string;
  /** Obrigatório em `vincular` e `revincular`; ignorado em `arquivar`. */
  toddleId?: string;
  /** Só YEAR_GROUP: em qual currículo do Toddle aquele id vive. */
  curriculumId?: string;
  /** Por que esta mudança. Obrigatório — ver `validarProposta`. */
  motivo: string;
}

export interface PropostaPendente {
  operationId: string;
  proposta: PropostaDeVinculo;
  /** A linha como estava quando a proposta foi criada. `null` = não existia. */
  snapshot: IdMapping | null;
  criadoPor: string | null;
  criadoPorQuem: string | null;
  criadoEm: string;
}

let tenantIdCache: string | null = null;
async function tenantId(exec: { query: typeof pgPool.query } = pgPool): Promise<string> {
  if (tenantIdCache) return tenantIdCache;
  const { rows } = await exec.query<{ id: string }>(
    "SELECT id FROM tenant WHERE slug = $1 AND status = 'active'",
    [cfg.slug],
  );
  if (!rows[0]) {
    throw new Error(`TENANT_SLUG="${cfg.slug}" não existe (ou está suspenso) na tabela tenant.`);
  }
  tenantIdCache = rows[0].id;
  return tenantIdCache;
}

/**
 * Recusa proposta malformada ANTES de ela existir.
 *
 * ─── AS DUAS REGRAS QUE PARECEM DETALHE E NÃO SÃO ───────────────────────────
 *
 * `YEAR_GROUP` exige `curriculumId` porque a organização tem DOIS currículos com
 * year groups de nomes duplicados entre si (dois "Batch of 2028", dois "Year 1"):
 * o id sozinho não diz a qual escada pertence, e um de-para já foi feito para a
 * escada errada por causa disso.
 *
 * `ASSESSMENT` exige chave composta `IDTURMADISC:CODETAPA:CODPROVA` porque
 * `CODPROVA` é sequencial POR turma-disciplina — existe uma "prova 1" em cada uma
 * das 186. Um código só com o número apontaria para a prova da turma errada, em
 * silêncio. A tela nunca deve deixar essa chave ser digitada: ela é escolhida de
 * lista resolvida da fonte, e esta validação é a rede embaixo disso.
 */
export function validarProposta(p: PropostaDeVinculo): string | null {
  if (!FORMAS.includes(p.forma)) return `forma inválida: use ${FORMAS.join(', ')}`;
  if (!ENTITY_TYPES.includes(p.entityType)) return `entityType inválido: ${p.entityType}`;
  if (!p.rmCode?.trim()) return 'rmCode é obrigatório';
  if (!p.motivo?.trim() || p.motivo.trim().length < 10) {
    return 'motivo é obrigatório e precisa dizer algo (mín. 10 caracteres): é o que alguém vai ler ' +
      'daqui a seis meses para entender por que este vínculo mudou';
  }
  if (p.forma !== 'arquivar' && !p.toddleId?.trim()) {
    return `toddleId é obrigatório em "${p.forma}"`;
  }
  if (p.entityType === 'YEAR_GROUP' && p.forma !== 'arquivar' && !p.curriculumId?.trim()) {
    return 'YEAR_GROUP exige curriculumId: a organização tem dois currículos com year groups de ' +
      'nomes duplicados, e o id sozinho não diz a qual escada pertence';
  }
  if (p.entityType === 'ASSESSMENT' && !/^[^:]+:[^:]+:[^:]+$/.test(p.rmCode.trim())) {
    return 'ASSESSMENT usa chave composta IDTURMADISC:CODETAPA:CODPROVA — CODPROVA é sequencial ' +
      'por turma-disciplina, então o número sozinho aponta para a prova da turma errada';
  }
  return null;
}

/**
 * Cria a proposta. Não toca em `id_mapping`.
 *
 * `idempotency_key` inclui a forma e o alvo: propor duas vezes a mesma coisa
 * atualiza a proposta em vez de empilhar duas pendências idênticas — que é o que
 * um duplo clique produziria.
 */
export async function propor(
  p: PropostaDeVinculo,
  criadoPor: string,
  ator: Ator,
): Promise<{ operationId: string; snapshot: IdMapping | null }> {
  const erro = validarProposta(p);
  if (erro) throw new Error(erro);

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const tid = await tenantId(client);

    const { rows: atuais } = await client.query<{ id: string; toddle_id: string; state: string; curriculum_id: string | null }>(
      `SELECT id, toddle_id, state, curriculum_id FROM id_mapping
        WHERE tenant_id = $1 AND target_instance_key = $2 AND entity_type = $3 AND rm_code = $4`,
      [tid, cfg.toddle.organizationId, p.entityType, p.rmCode.trim()],
    );
    const atual = atuais[0] ?? null;

    if (p.forma === 'vincular' && atual) {
      await client.query('ROLLBACK');
      throw new Error(
        `este rm_code já tem vínculo (toddle_id ${atual.toddle_id}, estado ${atual.state}). ` +
          'Para trocar o destino use "revincular"; para tirar de escopo, "arquivar"',
      );
    }
    if (p.forma !== 'vincular' && !atual) {
      await client.query('ROLLBACK');
      throw new Error(`não existe vínculo para este rm_code — use "vincular"`);
    }

    const snapshot = atual
      ? { id: atual.id, toddleId: atual.toddle_id, state: atual.state, curriculumId: atual.curriculum_id }
      : null;

    const chave = `${TIPO_OPERACAO}:${p.forma}:${p.entityType}:${p.rmCode.trim()}`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO operation (tenant_id, tipo, estado, payload, source_snapshot, idempotency_key, criado_por)
       VALUES ($1, $2, 'needs_review', $3, $4, $5, $6)
       ON CONFLICT (tenant_id, idempotency_key)
       DO UPDATE SET estado = 'needs_review', payload = EXCLUDED.payload,
                     source_snapshot = EXCLUDED.source_snapshot,
                     criado_por = EXCLUDED.criado_por, updated_at = now()
       RETURNING id`,
      [tid, TIPO_OPERACAO, JSON.stringify(p), JSON.stringify(snapshot), chave, criadoPor],
    );

    await registrarEvento(client, {
      ator,
      acao: 'mapping.vinculo.proposto',
      entidade: p.entityType,
      entidadeId: p.rmCode.trim(),
      antes: snapshot,
      depois: p,
      motivo: p.motivo,
      correlacaoId: chave,
      resultado: 'needs_review',
    });

    await client.query('COMMIT');
    return { operationId: rows[0].id, snapshot: snapshot as unknown as IdMapping | null };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** As propostas de vínculo esperando decisão, com o snapshot para a tela mostrar o diff. */
export async function propostasPendentes(): Promise<PropostaPendente[]> {
  const { rows } = await pgPool.query<{
    id: string; payload: PropostaDeVinculo; source_snapshot: IdMapping | null;
    criado_por: string | null; quem: string | null; created_at: Date;
  }>(
    `SELECT o.id, o.payload, o.source_snapshot, o.criado_por,
            COALESCE(u.email, u.nome, u.subject) AS quem, o.created_at
       FROM operation o
       LEFT JOIN user_identity u ON u.id = o.criado_por
      WHERE o.tenant_id = $1 AND o.tipo = $2 AND o.estado = 'needs_review'
      ORDER BY o.created_at DESC`,
    [await tenantId(), TIPO_OPERACAO],
  );
  return rows.map((r) => ({
    operationId: r.id,
    proposta: r.payload,
    snapshot: r.source_snapshot,
    criadoPor: r.criado_por,
    criadoPorQuem: r.quem,
    criadoEm: new Date(r.created_at).toISOString(),
  }));
}

export type ResultadoDaDecisao =
  | { ok: true; estado: 'aplicada' | 'recusada'; antes: unknown; depois: unknown }
  | { ok: false; erro: string };

/**
 * Decide e, se aprovada, APLICA — tudo numa transação.
 *
 * ─── A REVALIDAÇÃO DO SNAPSHOT É O CONTROLE, NÃO O CARIMBO ──────────────────
 *
 * Entre propor e aprovar pode ter passado um sync noturno. Se a linha mudou, o
 * diff que a pessoa leu na tela não descreve mais a realidade, e aprovar
 * aplicaria uma decisão tomada sobre outro estado. A aprovação perde validade —
 * é a mesma regra que a migration 006 já declarava para `payload` congelado.
 *
 * `FOR UPDATE` nas duas linhas (operação e mapeamento) na ordem operação →
 * mapeamento: ordem fixa evita deadlock entre duas decisões simultâneas.
 */
export async function decidirProposta(
  operationId: string,
  aprovador: string,
  decisao: 'approved' | 'rejected',
  motivo: string,
  ator: Ator,
): Promise<ResultadoDaDecisao> {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const tid = await tenantId(client);

    const { rows: ops } = await client.query<{
      tipo: string; estado: string; payload: PropostaDeVinculo;
      source_snapshot: { id: string; toddleId: string; state: string; curriculumId: string | null } | null;
      criado_por: string | null;
    }>(
      `SELECT tipo, estado, payload, source_snapshot, criado_por FROM operation
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tid, operationId],
    );
    const op = ops[0];
    if (!op) {
      await client.query('ROLLBACK');
      return { ok: false, erro: 'proposta não encontrada neste tenant' };
    }
    if (op.tipo !== TIPO_OPERACAO) {
      await client.query('ROLLBACK');
      return { ok: false, erro: `esta operação é do tipo "${op.tipo}", não é proposta de vínculo` };
    }
    if (op.estado !== 'needs_review') {
      await client.query('ROLLBACK');
      return { ok: false, erro: `proposta está em "${op.estado}", não em "needs_review"` };
    }

    // Segregação de funções, com a mesma exceção de um único aprovador que o
    // `approvalRepository` documenta por extenso. A regra vale onde significa
    // algo; com uma identidade só, não há de quem segregar.
    if (op.criado_por && op.criado_por === aprovador) {
      const aprovadores = await quantosPodemAprovar(client);
      // EXATAMENTE um, nunca zero — ver a explicação por extenso em
      // `approvalRepository.decidirOperacaoPorIdentidade`. Zero significa que
      // ninguém foi cadastrado, não que existe uma pessoa só.
      if (aprovadores !== 1) {
        await client.query('ROLLBACK');
        return {
          ok: false,
          erro:
            aprovadores === 0
              ? 'quem propôs não pode decidir, e este tenant não tem nenhuma identidade com papel ' +
                `de aprovação (${PAPEIS_QUE_APROVAM.join(' ou ')}). Conceda um com \`npm run conceder\`.`
              : `quem propôs não pode decidir: este tenant tem ${aprovadores} identidades com papel ` +
                `de aprovação (${PAPEIS_QUE_APROVAM.join(' ou ')})`,
        };
      }
    }

    await client.query(
      `INSERT INTO approval (operation_id, approver_id, decisao, motivo)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (operation_id, approver_id)
       DO UPDATE SET decisao = EXCLUDED.decisao, motivo = EXCLUDED.motivo, decidido_em = now()`,
      [operationId, aprovador, decisao, motivo],
    );

    const p = op.payload;

    if (decisao === 'rejected') {
      await client.query(`UPDATE operation SET estado = 'rejected', updated_at = now() WHERE id = $1`, [operationId]);
      await registrarEvento(client, {
        ator, acao: 'mapping.vinculo.recusado',
        entidade: p.entityType, entidadeId: p.rmCode,
        antes: op.source_snapshot, depois: null, motivo,
        correlacaoId: operationId, resultado: 'rejected',
      });
      await client.query('COMMIT');
      return { ok: true, estado: 'recusada', antes: op.source_snapshot, depois: null };
    }

    // ─── REVALIDAÇÃO ──────────────────────────────────────────────────────────
    const { rows: atuais } = await client.query<{
      id: string; toddle_id: string; state: string; curriculum_id: string | null;
    }>(
      `SELECT id, toddle_id, state, curriculum_id FROM id_mapping
        WHERE tenant_id = $1 AND target_instance_key = $2 AND entity_type = $3 AND rm_code = $4
        FOR UPDATE`,
      [tid, cfg.toddle.organizationId, p.entityType, p.rmCode],
    );
    const atual = atuais[0] ?? null;
    const snap = op.source_snapshot;

    const divergiu =
      (snap === null && atual !== null) ||
      (snap !== null && atual === null) ||
      (snap !== null && atual !== null &&
        (snap.toddleId !== atual.toddle_id ||
          snap.state !== atual.state ||
          (snap.curriculumId ?? null) !== atual.curriculum_id));

    if (divergiu) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        erro:
          'o mapeamento mudou depois da proposta, então o diff que você leu não descreve mais o ' +
          'estado atual e a aprovação perdeu validade. Confira o vínculo e proponha de novo. ' +
          `(snapshot: ${JSON.stringify(snap)} · agora: ${JSON.stringify(atual)})`,
      };
    }

    let depois: unknown;
    if (p.forma === 'arquivar') {
      const { rows } = await client.query<{ toddle_id: string; state: string }>(
        `UPDATE id_mapping
            SET state = 'archived', archived_at = now(), archive_reason = $5, updated_at = now()
          WHERE tenant_id = $1 AND target_instance_key = $2 AND entity_type = $3 AND rm_code = $4
          RETURNING toddle_id, state`,
        [tid, cfg.toddle.organizationId, p.entityType, p.rmCode, `proposta ${operationId}: ${motivo}`.slice(0, 300)],
      );
      depois = rows[0];
    } else if (p.forma === 'revincular') {
      // UPDATE, e não linha nova: ver o cabeçalho deste arquivo. O valor
      // anterior sobrevive só no `antes` do evento de auditoria abaixo.
      const { rows } = await client.query<{ toddle_id: string; state: string; curriculum_id: string | null }>(
        `UPDATE id_mapping
            SET toddle_id = $5, curriculum_id = COALESCE($6, curriculum_id),
                state = 'active', archived_at = NULL, archive_reason = NULL, updated_at = now()
          WHERE tenant_id = $1 AND target_instance_key = $2 AND entity_type = $3 AND rm_code = $4
          RETURNING toddle_id, state, curriculum_id`,
        [tid, cfg.toddle.organizationId, p.entityType, p.rmCode, p.toddleId, p.curriculumId ?? null],
      );
      depois = rows[0];
    } else {
      const { rows } = await client.query<{ toddle_id: string; state: string; curriculum_id: string | null }>(
        `INSERT INTO id_mapping (tenant_id, entity_type, rm_code, toddle_id, target_instance_key,
                                 state, curriculum_id, last_seen_in_scope_at)
         VALUES ($1, $3, $4, $5, $2, 'active', $6, now())
         RETURNING toddle_id, state, curriculum_id`,
        [tid, cfg.toddle.organizationId, p.entityType, p.rmCode, p.toddleId, p.curriculumId ?? null],
      );
      depois = rows[0];
    }

    // `approved`, NÃO `succeeded`.
    //
    // O CHECK de `operation` aceita só ('draft','validated','needs_review',
    // 'approved','rejected') desde a migration 011, que tirou os estados de
    // EXECUÇÃO desta tabela de propósito: `operation` é máquina de estados de
    // aprovação, `job_run` é registro de execução. Escrever 'succeeded' aqui é
    // recusado pelo banco — e essa recusa é o comportamento certo, não um
    // obstáculo. O que foi aplicado vai em `resultado`, que é para isso.
    await client.query(`UPDATE operation SET estado = 'approved', resultado = $2, updated_at = now() WHERE id = $1`,
      [operationId, JSON.stringify({ aplicado: depois, aplicadoEm: new Date().toISOString() })]);

    // Auditoria TRANSACIONAL, e aqui ela não é formalidade: num `revincular` o
    // `antes` é o único lugar onde o vínculo anterior continua existindo.
    await registrarEvento(client, {
      ator, acao: `mapping.vinculo.${p.forma}`,
      entidade: p.entityType, entidadeId: p.rmCode,
      antes: snap, depois, motivo,
      correlacaoId: operationId, resultado: 'aplicada',
    });

    await client.query('COMMIT');
    logger.warn(
      { operationId, forma: p.forma, entityType: p.entityType, rmCode: p.rmCode, antes: snap, depois },
      'VÍNCULO ALTERADO por proposta aprovada',
    );
    return { ok: true, estado: 'aplicada', antes: snap, depois };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    logger.error({ err, operationId }, 'Falha ao decidir a proposta de vínculo');
    return { ok: false, erro: (err as Error).message };
  } finally {
    client.release();
  }
}
