import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { tenantConfig } from '@rm-toddle/config';
import { decidirProposta, propor, propostasPendentes, validarProposta } from './mappingProposalRepository';
import { pgPool } from './pool';

/**
 * Mudança de vínculo como operação aprovável, contra Postgres DE VERDADE.
 *
 * ─── O QUE SÓ O BANCO PODE PROVAR ───────────────────────────────────────────
 *
 *   1. Que `propor` NÃO toca `id_mapping`. É a propriedade central: se um dia
 *      alguém "simplificar" aplicando direto, este teste cai.
 *   2. Que a revalidação do snapshot recusa a aprovação quando a linha mudou no
 *      meio — o controle que impede aplicar uma decisão tomada sobre outro
 *      estado.
 *   3. Que o DELETE em `id_mapping` é recusado pelo banco (migration 018).
 *
 * ─── COMO ESTA SUÍTE LIMPA ──────────────────────────────────────────────────
 *
 * As linhas de `id_mapping` NÃO são apagadas: o DELETE é justamente o que está
 * sendo impedido. Em vez disso, cada caso REDEFINE a linha de teste para um
 * estado conhecido com `ON CONFLICT DO UPDATE`. O efeito é o mesmo de um banco
 * limpo, sem pedir ao teste que faça o que a produção não pode fazer.
 */

const TIPO = 'SUBJECT' as const;
const RM_CODE = 'TESTE.PROPOSTA.001';
const TODDLE_ANTIGO = 'toddle-antigo-teste';
const TODDLE_NOVO = 'toddle-novo-teste';
const DESTINO = tenantConfig.toddle.organizationId;

async function tenantId(): Promise<string> {
  const { rows } = await pgPool.query<{ id: string }>(
    "select id from tenant where slug = $1", [tenantConfig.slug],
  );
  return rows[0].id;
}

/** Devolve a linha de teste a um estado conhecido, sem apagar nada. */
async function estadoInicial(): Promise<void> {
  await pgPool.query(
    `INSERT INTO id_mapping (tenant_id, entity_type, rm_code, toddle_id, target_instance_key, state)
     VALUES ($1, $2, $3, $4, $5, 'active')
     ON CONFLICT (tenant_id, entity_type, rm_code, target_instance_key)
     DO UPDATE SET toddle_id = EXCLUDED.toddle_id, state = 'active',
                   archived_at = NULL, archive_reason = NULL`,
    [await tenantId(), TIPO, RM_CODE, TODDLE_ANTIGO, DESTINO],
  );
}

async function identidade(sufixo: string): Promise<string> {
  const { rows } = await pgPool.query<{ id: string }>(
    `INSERT INTO user_identity (provider, subject, nome)
     VALUES ('cli', $1, $1)
     ON CONFLICT (provider, subject) DO UPDATE SET subject = EXCLUDED.subject
     RETURNING id`,
    [`teste.proposta:${sufixo}`],
  );
  return rows[0].id;
}

/**
 * ZERA os papéis do tenant da suíte antes de cada teste.
 *
 * ─── POR QUE APAGAR TUDO, E NÃO SÓ O QUE ESTE ARQUIVO CRIOU ─────────────────
 *
 * `quantosPodemAprovar` conta o TENANT INTEIRO, e é esse número que decide se a
 * auto-aprovação é recusada. Limpar só o próprio prefixo deixa cada arquivo à
 * mercê do que os outros esquecerem: três arquivos desta suíte criam papel de
 * aprovação, e a falha resultante aparece como "expected true to be false", sem
 * nada apontando para a causa. Foi assim que uma falha intermitente sobreviveu
 * dias — passava dez vezes isolada e caía na suíte inteira.
 *
 * É seguro apagar tudo porque o tenant é EXCLUSIVO da suíte: o `globalSetup`
 * recusa subir se `TENANT_SLUG` não for `integracao-teste`, justamente para que
 * limpezas como esta nunca alcancem a escola de verdade.
 */
async function zerarPapeisDoTenantDeTeste(): Promise<void> {
  await pgPool.query(
    `delete from membership where tenant_id in
       (select id from tenant where slug = $1)`,
    [tenantConfig.slug],
  );
}

const limpar = async (): Promise<void> => {
  await zerarPapeisDoTenantDeTeste();
  // Ordem obrigatória: approval.operation_id é ON DELETE RESTRICT, e o RESTRICT
  // é proposital — aprovação órfã seria registro de decisão sem a decisão.
  await pgPool.query(
    `delete from approval where operation_id in
       (select id from operation where idempotency_key like 'mapping.vinculo:%TESTE.PROPOSTA%')`,
  );
  await pgPool.query("delete from operation where idempotency_key like 'mapping.vinculo:%TESTE.PROPOSTA%'");
  // Só as concessões DESTE teste: a contagem de aprovadores do tenant é o que
  // liga e desliga a exceção de auto-aprovação, então cada caso precisa partir
  // de um número conhecido.
  await pgPool.query(
    `delete from membership where user_identity_id in
       (select id from user_identity where provider = 'cli' and subject like 'teste.proposta:%')`,
  );
};

/** Dá a este identidade o papel de aprovação neste tenant. */
async function podeAprovar(userIdentityId: string): Promise<void> {
  await pgPool.query(
    `INSERT INTO membership (user_identity_id, tenant_id, campus_id, papel)
     VALUES ($1, $2, NULL, 'approver')
     ON CONFLICT (user_identity_id, tenant_id, campus_id, papel) DO NOTHING`,
    [userIdentityId, await tenantId()],
  );
}

beforeEach(async () => {
  await limpar();
  await estadoInicial();
});

afterAll(async () => {
  await limpar();
  await pgPool.end();
});

describe('validarProposta', () => {
  it('exige motivo com conteúdo', () => {
    const erro = validarProposta({ forma: 'revincular', entityType: TIPO, rmCode: RM_CODE, toddleId: 'x', motivo: 'ok' });
    expect(erro).toContain('motivo');
  });

  it('exige curriculumId em YEAR_GROUP', () => {
    // A organização tem DOIS currículos com year groups de nomes duplicados; o
    // id sozinho não diz a qual escada pertence, e um de-para já foi feito para a
    // escada errada por causa disso.
    const erro = validarProposta({
      forma: 'revincular', entityType: 'YEAR_GROUP', rmCode: '1', toddleId: 'y',
      motivo: 'trocando de escada porque conferi no portal',
    });
    expect(erro).toContain('curriculumId');
  });

  it('exige chave composta em ASSESSMENT', () => {
    // CODPROVA é sequencial POR turma-disciplina: existe uma "prova 1" em cada
    // uma das 186. O número sozinho aponta para a prova da turma errada.
    const erro = validarProposta({
      forma: 'revincular', entityType: 'ASSESSMENT', rmCode: '1', toddleId: 'a',
      motivo: 'corrigindo o vínculo da prova',
    });
    expect(erro).toContain('IDTURMADISC');
  });
});

describe('propor', () => {
  it('cria a operação em needs_review e NÃO toca o de-para', async () => {
    const quem = await identidade('propositor');
    const { operationId } = await propor(
      { forma: 'revincular', entityType: TIPO, rmCode: RM_CODE, toddleId: TODDLE_NOVO, motivo: 'conferido no portal do Toddle' },
      quem, `user:${quem}`,
    );

    const { rows } = await pgPool.query<{ estado: string; source_snapshot: { toddleId: string } }>(
      'select estado, source_snapshot from operation where id = $1', [operationId],
    );
    expect(rows[0].estado).toBe('needs_review');
    expect(rows[0].source_snapshot.toddleId).toBe(TODDLE_ANTIGO);

    // O de-para segue intocado. Esta é a asserção que importa.
    const { rows: mapa } = await pgPool.query<{ toddle_id: string }>(
      'select toddle_id from id_mapping where entity_type = $1 and rm_code = $2 and tenant_id = $3',
      [TIPO, RM_CODE, await tenantId()],
    );
    expect(mapa[0].toddle_id).toBe(TODDLE_ANTIGO);
  });

  it('propor duas vezes o mesmo atualiza em vez de empilhar', async () => {
    // Duplo clique não deve gerar duas pendências idênticas para alguém decidir
    // duas vezes.
    const quem = await identidade('propositor');
    const p = { forma: 'revincular' as const, entityType: TIPO, rmCode: RM_CODE, toddleId: TODDLE_NOVO, motivo: 'conferido no portal do Toddle' };
    const a = await propor(p, quem, `user:${quem}`);
    const b = await propor(p, quem, `user:${quem}`);
    expect(a.operationId).toBe(b.operationId);
    expect((await propostasPendentes()).filter((x) => x.proposta.rmCode === RM_CODE)).toHaveLength(1);
  });

  it('recusa "vincular" quando já existe vínculo', async () => {
    const quem = await identidade('propositor');
    await expect(
      propor({ forma: 'vincular', entityType: TIPO, rmCode: RM_CODE, toddleId: TODDLE_NOVO, motivo: 'tentando criar em cima' }, quem, `user:${quem}`),
    ).rejects.toThrow(/já tem vínculo/);
  });
});

describe('decidirProposta', () => {
  it('aprovada por OUTRA pessoa: aplica o revincular e grava antes/depois na auditoria', async () => {
    const propositor = await identidade('propositor');
    const aprovador = await identidade('aprovador');
    await podeAprovar(aprovador);
    // Duas identidades com papel: a segregação de funções está em vigor, e este
    // é o caminho normal.
    await podeAprovar(propositor);

    const { operationId } = await propor(
      { forma: 'revincular', entityType: TIPO, rmCode: RM_CODE, toddleId: TODDLE_NOVO, motivo: 'conferido no portal do Toddle' },
      propositor, `user:${propositor}`,
    );

    const r = await decidirProposta(operationId, aprovador, 'approved', 'confirmei o id na interface', `user:${aprovador}`);
    expect(r.ok).toBe(true);

    const { rows } = await pgPool.query<{ toddle_id: string }>(
      'select toddle_id from id_mapping where entity_type = $1 and rm_code = $2 and tenant_id = $3',
      [TIPO, RM_CODE, await tenantId()],
    );
    expect(rows[0].toddle_id).toBe(TODDLE_NOVO);

    // O `antes` da auditoria é o ÚNICO lugar onde o vínculo anterior continua
    // existindo: a chave única impede guardar a linha velha ao lado da nova.
    const { rows: eventos } = await pgPool.query<{ antes: { toddleId: string } }>(
      "select antes from audit_event where correlacao_id = $1 and acao = 'mapping.vinculo.revincular'",
      [operationId],
    );
    expect(eventos[0].antes.toddleId).toBe(TODDLE_ANTIGO);
  });

  it('a operação termina em `approved`, nunca em `succeeded`', async () => {
    // O CHECK de `operation` só aceita ('draft','validated','needs_review',
    // 'approved','rejected') desde a migration 011, que tirou os estados de
    // EXECUÇÃO desta tabela de propósito. Gravar 'succeeded' aqui é recusado pelo
    // banco — e foi assim que a primeira versão deste código falhou.
    const propositor = await identidade('propositor');
    const aprovador = await identidade('aprovador');
    await podeAprovar(propositor);
    await podeAprovar(aprovador);

    const { operationId } = await propor(
      { forma: 'revincular', entityType: TIPO, rmCode: RM_CODE, toddleId: TODDLE_NOVO, motivo: 'conferido no portal do Toddle' },
      propositor, `user:${propositor}`,
    );
    await decidirProposta(operationId, aprovador, 'approved', 'confirmei o id na interface', `user:${aprovador}`);

    const { rows } = await pgPool.query<{ estado: string; resultado: { aplicado: unknown } }>(
      'select estado, resultado from operation where id = $1', [operationId],
    );
    expect(rows[0].estado).toBe('approved');
    expect(rows[0].resultado.aplicado).toBeTruthy();
  });

  it('com UM único aprovador, quem propôs pode decidir', async () => {
    // A exceção, e o raciocínio é o mesmo da regra: não há de quem segregar. O
    // controle que resta são os dois passos com diff e o registro da decisão —
    // que nunca foi o controle de duas mãos que fazia o gate valer para uma
    // pessoa só.
    const solo = await identidade('propositor');
    await podeAprovar(solo);

    const { operationId } = await propor(
      { forma: 'revincular', entityType: TIPO, rmCode: RM_CODE, toddleId: TODDLE_NOVO, motivo: 'conferido no portal do Toddle' },
      solo, `user:${solo}`,
    );
    const r = await decidirProposta(operationId, solo, 'approved', 'sou o único que aprova aqui', `user:${solo}`);
    expect(r.ok).toBe(true);
  });

  it('com ZERO aprovadores cadastrados, quem propôs NÃO decide', async () => {
    // A distinção que separa a exceção de um buraco: zero não é "uma pessoa só",
    // é "membership nunca foi preenchida" — o estado atual do tenant real. Se
    // zero liberasse, a regra desapareceria justamente onde ninguém configurou
    // nada.
    const solo = await identidade('propositor');

    const { operationId } = await propor(
      { forma: 'revincular', entityType: TIPO, rmCode: RM_CODE, toddleId: TODDLE_NOVO, motivo: 'conferido no portal do Toddle' },
      solo, `user:${solo}`,
    );
    const r = await decidirProposta(operationId, solo, 'approved', 'tentando aprovar sozinho', `user:${solo}`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.erro).toContain('npm run conceder');
  });

  it('recusa a aprovação quando o de-para mudou depois da proposta', async () => {
    // O controle de verdade. Entre propor e aprovar pode ter passado um sync
    // noturno; o diff que a pessoa leu deixaria de descrever a realidade.
    const propositor = await identidade('propositor');
    const aprovador = await identidade('aprovador');
    await podeAprovar(propositor);
    await podeAprovar(aprovador);

    const { operationId } = await propor(
      { forma: 'revincular', entityType: TIPO, rmCode: RM_CODE, toddleId: TODDLE_NOVO, motivo: 'conferido no portal do Toddle' },
      propositor, `user:${propositor}`,
    );

    await pgPool.query(
      'update id_mapping set toddle_id = $1 where entity_type = $2 and rm_code = $3 and tenant_id = $4',
      ['mudou-no-meio', TIPO, RM_CODE, await tenantId()],
    );

    const r = await decidirProposta(operationId, aprovador, 'approved', 'aprovando sem saber que mudou', `user:${aprovador}`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.erro).toContain('perdeu validade');

    // E nada foi escrito: a linha continua com o valor que outro processo pôs.
    const { rows } = await pgPool.query<{ toddle_id: string }>(
      'select toddle_id from id_mapping where entity_type = $1 and rm_code = $2 and tenant_id = $3',
      [TIPO, RM_CODE, await tenantId()],
    );
    expect(rows[0].toddle_id).toBe('mudou-no-meio');
  });

  it('recusada: não aplica, e registra a decisão', async () => {
    const propositor = await identidade('propositor');
    const aprovador = await identidade('aprovador');
    await podeAprovar(propositor);
    await podeAprovar(aprovador);

    const { operationId } = await propor(
      { forma: 'revincular', entityType: TIPO, rmCode: RM_CODE, toddleId: TODDLE_NOVO, motivo: 'conferido no portal do Toddle' },
      propositor, `user:${propositor}`,
    );

    const r = await decidirProposta(operationId, aprovador, 'rejected', 'o id era de outra turma', `user:${aprovador}`);
    expect(r.ok && r.estado).toBe('recusada');

    const { rows } = await pgPool.query<{ toddle_id: string }>(
      'select toddle_id from id_mapping where entity_type = $1 and rm_code = $2 and tenant_id = $3',
      [TIPO, RM_CODE, await tenantId()],
    );
    expect(rows[0].toddle_id).toBe(TODDLE_ANTIGO);

    const { rowCount } = await pgPool.query(
      'select 1 from approval where operation_id = $1 and decisao = $2', [operationId, 'rejected'],
    );
    expect(rowCount).toBe(1);
  });

  it('arquivar preserva a linha e o toddle_id', async () => {
    // Arquivar NUNCA apaga: o toddle_id é o único caminho de volta para um
    // registro arquivado no Toddle.
    const solo = await identidade('propositor');
    await podeAprovar(solo);

    const { operationId } = await propor(
      { forma: 'arquivar', entityType: TIPO, rmCode: RM_CODE, motivo: 'saiu de escopo neste ano letivo' },
      solo, `user:${solo}`,
    );
    await decidirProposta(operationId, solo, 'approved', 'confirmado com a secretaria', `user:${solo}`);

    const { rows } = await pgPool.query<{ toddle_id: string; state: string; archive_reason: string }>(
      'select toddle_id, state, archive_reason from id_mapping where entity_type = $1 and rm_code = $2 and tenant_id = $3',
      [TIPO, RM_CODE, await tenantId()],
    );
    expect(rows[0].state).toBe('archived');
    expect(rows[0].toddle_id).toBe(TODDLE_ANTIGO);
    expect(rows[0].archive_reason).toContain('confirmado com a secretaria');
  });
});

describe('id_mapping sem DELETE (migration 018)', () => {
  it('o banco recusa DELETE, com a razão na mensagem', async () => {
    await expect(
      pgPool.query('delete from id_mapping where entity_type = $1 and rm_code = $2', [TIPO, RM_CODE]),
    ).rejects.toThrow(/único caminho de volta/);
  });

  it('recusa TRUNCATE', async () => {
    await expect(pgPool.query('truncate id_mapping')).rejects.toThrow(/recusado/);
  });
});
