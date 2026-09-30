import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as integrations from '@rm-toddle/integrations';
import { conferirSentencasUmaVez } from './canarioDeSentencas';

/**
 * O CANÁRIO PARA NA PRIMEIRA RECUSA DE CREDENCIAL.
 *
 * ─── O INCIDENTE QUE ISTO EXISTE PARA NÃO REPETIR ───────────────────────────
 *
 * Em 29/09/2026 eu bloqueei o usuário da integração no RM testando o canário:
 * seis autenticações inválidas seguidas bastaram. A senha estava certa — a
 * leitura bem-sucedida das seis Sentenças um minuto antes prova isso. O que
 * bloqueou foi a REPETIÇÃO.
 *
 * O canário autentica uma vez por Sentença, seis por ciclo, de hora em hora:
 * 144 por dia. Se a credencial for recusada, um único ciclo já gasta as seis e
 * bloqueia o usuário — o vigia virando a causa do incidente que ele observa.
 *
 * ─── A MITIGAÇÃO NÃO DEPENDE DE CONHECER A JANELA DE CONTAGEM ───────────────
 *
 * Ninguém sabe se o RM conta tentativas por minuto, por hora ou desde sempre
 * (pendência em docs/TODO.md). A regra é segura em qualquer hipótese porque
 * nunca chega perto de seis: para na PRIMEIRA.
 */

vi.mock('@rm-toddle/integrations', async (original) => ({
  ...(await original<typeof integrations>()),
  conferir: vi.fn(),
}));

const conferir = vi.mocked(integrations.conferir);

const conferencia = (codigo: string): integrations.ConferenciaDeSentenca =>
  ({
    codigo,
    existeNoRm: true,
    confere: true,
    verificacaoCompleta: true,
    releitura: { ok: true, detalhe: 'idêntica' },
    execucao: { ok: true, detalhe: 'executou', colunasAusentes: [] },
    volume: { ok: true, linhas: 10, detalhe: 'ok' },
    reprovouEm: null,
    aviso: null,
  }) as integrations.ConferenciaDeSentenca;

/** Como o `wsConsultaSqlClient` monta a recusa: `Error` com a marca anexada. */
const recusa = (): Error =>
  Object.assign(new Error('wsConsultaSQL falhou (TODDLE.X) (HTTP 401): Usuário ou Senha inválidos!'), {
    recusouCredencial: true,
  });

beforeEach(() => {
  conferir.mockReset();
});

describe('a primeira recusa interrompe o ciclo inteiro', () => {
  it('a credencial falha na PRIMEIRA: só uma tentativa é feita', async () => {
    conferir.mockRejectedValue(recusa());

    const passada = await conferirSentencasUmaVez({ executar: false });

    expect(
      conferir,
      'o canário tentou as seis Sentenças com uma credencial que já tinha sido recusada — ' +
        'é exatamente o que bloqueou o usuário do RM em 29/09/2026',
    ).toHaveBeenCalledTimes(1);
    expect(passada.credencialRecusada).toBe(true);
  });

  it('a credencial falha na TERCEIRA: as outras três não são tentadas', async () => {
    conferir
      .mockResolvedValueOnce(conferencia('TODDLE.STUDENTS'))
      .mockResolvedValueOnce(conferencia('TODDLE.TURMADISC'))
      .mockRejectedValueOnce(recusa());

    const passada = await conferirSentencasUmaVez({ executar: false });

    expect(conferir).toHaveBeenCalledTimes(3);
    expect(passada.avaliadas).toHaveLength(2);
    expect(passada.credencialRecusada).toBe(true);
  });

  it('nunca chega perto de seis, qualquer que seja a janela do RM', async () => {
    conferir.mockRejectedValue(recusa());
    await conferirSentencasUmaVez({ executar: false });
    // A garantia que importa é numérica: seis bloqueiam, e nós fazemos uma.
    expect(conferir.mock.calls.length).toBeLessThan(6);
  });
});

describe('outras falhas NÃO interrompem — o canário continua vigiando', () => {
  /**
   * A assimetria: parar por recusa de credencial protege o usuário do RM;
   * parar por timeout trocaria o vigia por silêncio. Timeout é a falha mais
   * comum, e ela não acumula tentativa inválida.
   */
  it('timeout numa Sentença não impede as demais', async () => {
    conferir
      .mockRejectedValueOnce(new Error('ECONNABORTED: timeout of 120000ms exceeded'))
      .mockResolvedValue(conferencia('TODDLE.X'));

    const passada = await conferirSentencasUmaVez({ executar: false });

    expect(conferir).toHaveBeenCalledTimes(6);
    expect(passada.credencialRecusada).toBe(false);
    expect(passada.naoVerificadas).toEqual(['TODDLE.STUDENTS']);
    expect(passada.avaliadas).toHaveLength(5);
  });

  it('HTTP 500 do RM não é recusa de credencial', async () => {
    conferir
      .mockRejectedValueOnce(new Error('wsConsultaSQL falhou (X) (HTTP 500): erro interno'))
      .mockResolvedValue(conferencia('TODDLE.X'));

    const passada = await conferirSentencasUmaVez({ executar: false });

    expect(conferir).toHaveBeenCalledTimes(6);
    expect(passada.credencialRecusada).toBe(false);
  });

  it('todas falhando por rede: as seis são tentadas, e nenhuma é recusa', async () => {
    conferir.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.1:1951'));

    const passada = await conferirSentencasUmaVez({ executar: false });

    expect(conferir).toHaveBeenCalledTimes(6);
    expect(passada.naoVerificadas).toHaveLength(6);
    expect(passada.credencialRecusada).toBe(false);
  });
});

describe('o caminho feliz não muda', () => {
  it('seis conferências, nenhum achado, sem recusa', async () => {
    conferir.mockResolvedValue(conferencia('TODDLE.X'));

    const passada = await conferirSentencasUmaVez({ executar: false });

    expect(passada.avaliadas).toHaveLength(6);
    expect(passada.achados).toEqual([]);
    expect(passada.credencialRecusada).toBe(false);
  });
});
