import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { idMappingRepository } from './idMappingRepository';
import { pgPool } from './pool';

/**
 * O carimbo de payload, contra Postgres DE VERDADE.
 *
 * O que está em jogo aqui não é economia de chamada — é não apagar aluno.
 *
 * O sync passou a pular a escrita quando o payload é idêntico ao da última vez.
 * Mas o upsert do mapeamento tem de acontecer MESMO ASSIM, porque é ele que
 * renova `last_seen_in_scope_at` — e é por esse campo que o middleware decide
 * quem saiu do escopo e deve ser ARQUIVADO no Toddle. Se o pulo levasse o upsert
 * junto, a otimização viraria exclusão em massa, em silêncio, alguns dias depois.
 *
 * O outro risco é o inverso e igualmente mudo: quem pula NÃO passa hash, e um
 * `EXCLUDED.payload_hash` puro gravaria NULL por cima do hash de quem escreveu.
 * O efeito seria a economia sumir na passada seguinte, sem nenhum erro.
 *
 * Os dois são comportamento do `ON CONFLICT`, então mockar testaria o mock.
 *
 * ─── COMO ESTA SUÍTE LIMPA ──────────────────────────────────────────────────
 *
 * Não apaga: `DELETE` em `id_mapping` é recusado pelo banco (migração 018), e é
 * um controle que existe porque apagar a linha destrói o único caminho de volta
 * para um aluno arquivado no Toddle — custou 186 alunos em 31/07/2026. Cada caso
 * REDEFINE a linha para um estado conhecido, que dá o mesmo resultado sem pedir
 * ao teste o que a produção não pode fazer.
 */

const RA = 'TESTE-HASH-001';

/** Volta a linha ao estado "nunca escrita", sem apagá-la. */
async function zerar(): Promise<void> {
  await pgPool.query(
    `update id_mapping
        set payload_hash = NULL, payload_escrito_em = NULL, last_seen_in_scope_at = now()
      where rm_code = $1`,
    [RA],
  );
}

beforeEach(zerar);
afterAll(async () => {
  await zerar();
  await pgPool.end();
});

const gravar = (payloadHash?: string) =>
  idMappingRepository.upsert({
    entityType: 'STUDENT',
    rmCode: RA,
    toddleId: 'toddle-hash-001',
    payloadHash,
  });

describe('payload_hash no upsert de mapeamento', () => {
  it('grava hash e carimbo quando a escrita aconteceu', async () => {
    const m = await gravar('abc123');
    expect(m.payloadHash).toBe('abc123');
    expect(m.payloadEscritoEm).toBeInstanceOf(Date);
  });

  it('nasce sem hash quando ninguém escreveu ainda', async () => {
    const m = await gravar();
    expect(m.payloadHash).toBeNull();
    expect(m.payloadEscritoEm).toBeNull();
  });

  /** O teste que impede a otimização de virar exclusão. */
  it('upsert SEM hash (escrita pulada) renova last_seen_in_scope_at', async () => {
    await gravar('abc123');
    await pgPool.query(
      "update id_mapping set last_seen_in_scope_at = now() - interval '30 days' where rm_code = $1",
      [RA],
    );

    const depois = await gravar(); // passada em que nada mudou

    const idade = Date.now() - (depois.lastSeenInScopeAt?.getTime() ?? 0);
    expect(idade).toBeLessThan(60_000);
  });

  it('upsert SEM hash preserva o hash e o carimbo de quem escreveu antes', async () => {
    const escrito = await gravar('abc123');
    const pulado = await gravar();

    expect(pulado.payloadHash).toBe('abc123');
    expect(pulado.payloadEscritoEm?.getTime()).toBe(escrito.payloadEscritoEm?.getTime());
  });

  it('hash novo substitui o anterior e move o carimbo', async () => {
    const antes = await gravar('abc123');
    await new Promise((r) => setTimeout(r, 15));
    const depois = await gravar('def456');

    expect(depois.payloadHash).toBe('def456');
    expect(depois.payloadEscritoEm!.getTime()).toBeGreaterThan(antes.payloadEscritoEm!.getTime());
  });
});
