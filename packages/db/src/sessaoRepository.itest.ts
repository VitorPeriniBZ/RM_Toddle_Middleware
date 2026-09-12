import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pgPool } from './pool';
import {
  apagarSessoesMortas,
  criarSessao,
  hashDoToken,
  revogarPorToken,
  revogarSessao,
  revogarTodasDe,
  sessaoAtiva,
  sessoesVivasDe,
  tocarSessao,
} from './sessaoRepository';

/**
 * A sessão, contra Postgres de verdade.
 *
 * O que precisa ser verdade aqui não é "o INSERT funciona" — é que os quatro
 * jeitos de uma sessão MORRER realmente a matam, e que o cookie nunca aparece
 * no banco. Um mock provaria a primeira coisa e nenhuma das outras.
 */
const OCIOSO = 60_000;
const ABSOLUTO = 600_000;
const ORIGEM = { ip: '10.0.0.1', userAgent: 'teste' };

async function limpar(): Promise<void> {
  await pgPool.query(`DELETE FROM sessao WHERE subject LIKE 'teste-%'`);
}

beforeEach(limpar);
afterAll(async () => {
  await limpar();
  await pgPool.end();
});

describe('sessão de servidor', () => {
  it('o cookie NUNCA aparece no banco — só o hash dele', async () => {
    const { cru } = await criarSessao('teste-a', 'a@x.com', OCIOSO, ABSOLUTO, ORIGEM);

    const { rows } = await pgPool.query<{ token_hash: string }>(
      `SELECT token_hash FROM sessao WHERE subject = 'teste-a'`,
    );
    expect(rows[0].token_hash).toBe(hashDoToken(cru));
    expect(rows[0].token_hash).not.toBe(cru);

    // A prova que importa: procurar pelo valor do cookie não acha nada. Um dump
    // do banco não entrega sessão nenhuma.
    const { rowCount } = await pgPool.query(`SELECT 1 FROM sessao WHERE token_hash = $1`, [cru]);
    expect(rowCount).toBe(0);
  });

  it('resolve o cookie para a identidade', async () => {
    const { cru } = await criarSessao('teste-b', 'b@x.com', OCIOSO, ABSOLUTO, ORIGEM);
    const s = await sessaoAtiva(cru);
    expect(s?.subject).toBe('teste-b');
    expect(s?.email).toBe('b@x.com');
  });

  it('não resolve cookie desconhecido nem ausente', async () => {
    expect(await sessaoAtiva('nao-existe')).toBeNull();
    expect(await sessaoAtiva(undefined)).toBeNull();
  });

  // ─── OS QUATRO JEITOS DE MORRER ───────────────────────────────────────────

  it('morre revogada — e é isto que faltava: dá para deslogar alguém', async () => {
    const { cru, sessao } = await criarSessao('teste-c', null, OCIOSO, ABSOLUTO, ORIGEM);
    expect(await sessaoAtiva(cru)).not.toBeNull();
    await revogarSessao(sessao.id, 'logout');
    expect(await sessaoAtiva(cru)).toBeNull();
  });

  it('morre pelo cookie, que é o caminho do logout', async () => {
    const { cru } = await criarSessao('teste-d', null, OCIOSO, ABSOLUTO, ORIGEM);
    const r = await revogarPorToken(cru, 'logout');
    expect(r?.subject).toBe('teste-d');
    expect(await sessaoAtiva(cru)).toBeNull();
    // Sair duas vezes não é erro, e não ressuscita nada.
    expect(await revogarPorToken(cru, 'logout')).toBeNull();
  });

  it('morre por inatividade', async () => {
    const { cru } = await criarSessao('teste-e', null, OCIOSO, ABSOLUTO, ORIGEM);
    await pgPool.query(`UPDATE sessao SET ocioso_ate = now() - interval '1 minute' WHERE subject = 'teste-e'`);
    expect(await sessaoAtiva(cru)).toBeNull();
  });

  it('morre no teto absoluto, mesmo com o ocioso em dia', async () => {
    const { cru } = await criarSessao('teste-f', null, OCIOSO, ABSOLUTO, ORIGEM);
    await pgPool.query(
      `UPDATE sessao SET expira_em = now() - interval '1 minute',
                         ocioso_ate = now() + interval '1 hour'
        WHERE subject = 'teste-f'`,
    );
    expect(await sessaoAtiva(cru)).toBeNull();
  });

  // ─── O DESLIZE, E O QUE ELE NÃO PODE FAZER ────────────────────────────────

  it('desliza o prazo de inatividade quando passou do throttle', async () => {
    const { cru, sessao } = await criarSessao('teste-g', null, OCIOSO, ABSOLUTO, ORIGEM);
    await pgPool.query(
      `UPDATE sessao SET vista_em = now() - interval '10 minutes',
                         ocioso_ate = now() + interval '10 seconds'
        WHERE id = $1`,
      [sessao.id],
    );
    const antes = await sessaoAtiva(cru);

    await tocarSessao({ ...antes!, vistaEm: new Date(Date.now() - 600_000) }, OCIOSO);

    const depois = await sessaoAtiva(cru);
    expect(depois!.ociosoAte.getTime()).toBeGreaterThan(antes!.ociosoAte.getTime());
  });

  // Sem este limite, uma aba aberta para sempre seria uma sessão eterna — e o
  // teto absoluto, que é o que garante que ela termina, viraria decoração.
  it('o deslize NUNCA ultrapassa o teto absoluto', async () => {
    const { cru, sessao } = await criarSessao('teste-h', null, OCIOSO, 5_000, ORIGEM);
    await pgPool.query(`UPDATE sessao SET vista_em = now() - interval '10 minutes' WHERE id = $1`, [sessao.id]);

    const antes = await sessaoAtiva(cru);
    // Pede um ocioso de 1 hora, muito além do teto de 5 segundos.
    await tocarSessao({ ...antes!, vistaEm: new Date(Date.now() - 600_000) }, 3_600_000);

    const depois = await sessaoAtiva(cru);
    expect(depois!.ociosoAte.getTime()).toBeLessThanOrEqual(depois!.expiraEm.getTime());
  });

  it('não escreve a cada requisição — respeita o throttle', async () => {
    const { cru } = await criarSessao('teste-i', null, OCIOSO, ABSOLUTO, ORIGEM);
    const antes = await sessaoAtiva(cru);
    await tocarSessao(antes!, OCIOSO); // vista_em é de agora: deve ignorar
    const depois = await sessaoAtiva(cru);
    expect(depois!.vistaEm.getTime()).toBe(antes!.vistaEm.getTime());
  });

  // ─── DERRUBAR TUDO ────────────────────────────────────────────────────────

  it('derruba todas as sessões de alguém', async () => {
    const a = await criarSessao('teste-j', null, OCIOSO, ABSOLUTO, ORIGEM);
    const b = await criarSessao('teste-j', null, OCIOSO, ABSOLUTO, ORIGEM);
    expect(await revogarTodasDe('teste-j', 'admin')).toBe(2);
    expect(await sessaoAtiva(a.cru)).toBeNull();
    expect(await sessaoAtiva(b.cru)).toBeNull();
  });

  // "Encerrar as OUTRAS": quem desconfia de uma cópia não quer se deslogar do
  // aparelho em que está.
  it('derruba as outras e preserva a atual', async () => {
    const atual = await criarSessao('teste-k', null, OCIOSO, ABSOLUTO, ORIGEM);
    const outra = await criarSessao('teste-k', null, OCIOSO, ABSOLUTO, ORIGEM);

    expect(await revogarTodasDe('teste-k', 'revogar_outras', { excetoId: atual.sessao.id })).toBe(1);
    expect(await sessaoAtiva(atual.cru)).not.toBeNull();
    expect(await sessaoAtiva(outra.cru)).toBeNull();
  });

  it('lista só as sessões vivas, e não vaza o hash', async () => {
    const viva = await criarSessao('teste-l', null, OCIOSO, ABSOLUTO, ORIGEM);
    const morta = await criarSessao('teste-l', null, OCIOSO, ABSOLUTO, ORIGEM);
    await revogarSessao(morta.sessao.id, 'logout');

    const lista = await sessoesVivasDe('teste-l');
    expect(lista).toHaveLength(1);
    expect(lista[0].id).toBe(viva.sessao.id);
    expect(JSON.stringify(lista)).not.toContain('token');
  });

  // ─── LIMPEZA ──────────────────────────────────────────────────────────────

  // A linha revogada é a prova de até quando aquele acesso funcionou. Apagá-la
  // no vencimento jogaria fora a resposta de uma investigação.
  it('a limpeza poupa o que morreu há pouco e apaga o que morreu há muito', async () => {
    await criarSessao('teste-m', null, OCIOSO, ABSOLUTO, ORIGEM);
    await pgPool.query(`UPDATE sessao SET expira_em = now() - interval '2 days' WHERE subject = 'teste-m'`);
    await apagarSessoesMortas();
    expect((await pgPool.query(`SELECT 1 FROM sessao WHERE subject = 'teste-m'`)).rowCount).toBe(1);

    await pgPool.query(`UPDATE sessao SET expira_em = now() - interval '30 days' WHERE subject = 'teste-m'`);
    await apagarSessoesMortas();
    expect((await pgPool.query(`SELECT 1 FROM sessao WHERE subject = 'teste-m'`)).rowCount).toBe(0);
  });
});
