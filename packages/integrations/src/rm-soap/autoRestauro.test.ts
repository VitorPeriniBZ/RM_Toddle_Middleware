import { beforeEach, describe, expect, it, vi } from 'vitest';
import { restaurarSeAusente, sentencaAusenteNaMensagem } from './autoRestauro';
import * as sentencas from './sentencasDoRm';

/**
 * O que se testa aqui é a DECISÃO de escrever no RM, não o SOAP.
 *
 * `conferir` e `restaurar` são nossos e estão dublados de propósito — o que
 * precisa de prova é o caminho que a decisão toma, e ele tem um ramo cujo erro
 * não dá erro nenhum: sobrescrever uma Sentença que ESTÁ no RM. Se isso
 * acontecer, o RM aceita, o job passa, a tela fica verde — e um SQL que alguém
 * ajustou pela UI foi silenciosamente rebaixado para a versão do repositório,
 * alimentando todos os fluxos a partir dali.
 *
 * Por isso o teste central aqui não é "restaurou": é **"não escreveu"**.
 */

vi.mock('./sentencasDoRm', async (original) => ({
  ...(await original<typeof sentencas>()),
  conferir: vi.fn(),
  restaurar: vi.fn(),
}));

const conferir = vi.mocked(sentencas.conferir);
const restaurar = vi.mocked(sentencas.restaurar);

/** Uma conferência com os campos que a decisão olha. O resto é preenchimento. */
function conferencia(over: Partial<sentencas.ConferenciaDeSentenca>): sentencas.ConferenciaDeSentenca {
  return {
    codigo: 'TODDLE.TURMADISC',
    existeNoRm: false,
    confere: false,
    verificacaoCompleta: true,
    releitura: { ok: false, detalhe: 'não existe no RM' },
    execucao: { ok: false, detalhe: 'não executada', colunasAusentes: [] },
    volume: { ok: false, linhas: null, detalhe: 'não contado' },
    reprovouEm: 'releitura',
    aviso: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sentencaAusenteNaMensagem', () => {
  /** A frase exata que o RM devolveu em 22/09/2026, depois da cópia de base. */
  const RECUSA =
    'wsConsultaSQL SOAP Fault (TODDLE.TURMADISC): A consulta SQL utilizando a chave ' +
    '1|S|TODDLE.TURMADISC não existe ou não pôde ser executada por restrição de filtro por perfil/usuário.';

  it('tira o código da CHAVE que o RM devolveu, não do que o chamador pediu', () => {
    expect(sentencaAusenteNaMensagem(RECUSA)).toBe('TODDLE.TURMADISC');
  });

  /**
   * As outras falhas do RM não podem disparar escrita. Em especial a de
   * parâmetros: ela significa que a Sentença EXISTE (o RM chegou a comparar a
   * assinatura dela), e é justamente o oposto do caso que restaura.
   */
  it.each([
    ['parâmetros', 'wsConsultaSQL SOAP Fault (X): Quantidade de parâmetros passados para o SQL não corresponde ao esperado'],
    ['credencial', 'wsConsultaSQL falhou (X) (HTTP 401): Usuário ou Senha inválidos!'],
    ['dataset', 'wsConsultaSQL (X) respondeu SEM dataset.'],
    ['rede', 'connect ETIMEDOUT 10.0.0.1:1951'],
    ['vazia', ''],
  ])('não reconhece a mensagem de %s', (_rotulo, mensagem) => {
    expect(sentencaAusenteNaMensagem(mensagem)).toBeNull();
  });
});

describe('restaurarSeAusente', () => {
  it('recoloca quando a Sentença SUMIU do RM', async () => {
    conferir.mockResolvedValue(conferencia({ existeNoRm: false }));
    restaurar.mockResolvedValue({
      ...conferencia({ existeNoRm: true, confere: true, reprovouEm: null }),
      volume: { ok: true, linhas: 714, detalhe: '714 linhas' },
      gravou: true,
      desconhecido: false,
      respostaDoRm: null,
    });

    const r = await restaurarSeAusente('TODDLE.TURMADISC');

    expect(r.desfecho).toBe('restaurada');
    expect(restaurar).toHaveBeenCalledOnce();
  });

  /** O teste que justifica o módulo inteiro. */
  it('NÃO escreve quando a Sentença está lá — aí a recusa é de permissão', async () => {
    conferir.mockResolvedValue(conferencia({ existeNoRm: true, confere: true, releitura: { ok: true, detalhe: 'idêntico ao .sql' } }));

    const r = await restaurarSeAusente('TODDLE.TURMADISC');

    expect(r.desfecho).toBe('existe');
    expect(restaurar).not.toHaveBeenCalled();
    expect(r.detalhe).toMatch(/permissão\/perfil/);
  });

  /**
   * Presente e DIVERGENTE também não é caso de escrita automática: o RM pode
   * estar à frente do repositório, e "restaurar" seria rebaixar sem ninguém ver.
   */
  it('NÃO escreve quando a Sentença está lá porém divergente do .sql', async () => {
    conferir.mockResolvedValue(
      conferencia({ existeNoRm: true, confere: false, releitura: { ok: false, detalhe: 'difere do .sql em 3 caracteres' } }),
    );

    const r = await restaurarSeAusente('TODDLE.TURMADISC');

    expect(r.desfecho).toBe('existe');
    expect(restaurar).not.toHaveBeenCalled();
    expect(r.detalhe).toMatch(/divergente/);
  });

  it('não tenta nada para código que não é do catálogo', async () => {
    const r = await restaurarSeAusente('RELATORIO.DO.FINANCEIRO');

    expect(r.desfecho).toBe('fora-do-catalogo');
    expect(conferir).not.toHaveBeenCalled();
    expect(restaurar).not.toHaveBeenCalled();
  });

  it('diz que falhou quando recoloca e a conferência reprova', async () => {
    conferir.mockResolvedValue(conferencia({ existeNoRm: false }));
    restaurar.mockResolvedValue({
      ...conferencia({ existeNoRm: true, confere: false, reprovouEm: 'execucao' }),
      execucao: { ok: false, detalhe: 'o RM recusou executar: erro de sintaxe', colunasAusentes: [] },
      gravou: true,
      desconhecido: false,
      respostaDoRm: 'erro',
    });

    const r = await restaurarSeAusente('TODDLE.TURMADISC');

    expect(r.desfecho).toBe('falhou');
    expect(r.detalhe).toContain('reprovou em execucao');
  });

  /**
   * O fan-out de alunos são 50 lotes. Cinquenta jobs esbarrando na mesma
   * Sentença ausente não podem virar cinquenta SaveRecord do mesmo texto.
   */
  it('junta as chamadas concorrentes do mesmo código numa restauração só', async () => {
    conferir.mockResolvedValue(conferencia({ existeNoRm: false }));
    restaurar.mockResolvedValue({
      ...conferencia({ existeNoRm: true, confere: true, reprovouEm: null }),
      gravou: true,
      desconhecido: false,
      respostaDoRm: null,
    });

    const todas = await Promise.all(
      Array.from({ length: 50 }, () => restaurarSeAusente('TODDLE.TURMADISC')),
    );

    expect(todas.every((r) => r.desfecho === 'restaurada')).toBe(true);
    expect(conferir).toHaveBeenCalledOnce();
    expect(restaurar).toHaveBeenCalledOnce();
  });

  it('não deixa a falha da própria restauração escapar como exceção', async () => {
    conferir.mockRejectedValue(new Error('RM fora do ar'));

    const r = await restaurarSeAusente('TODDLE.TURMADISC');

    expect(r.desfecho).toBe('falhou');
    expect(r.detalhe).toContain('RM fora do ar');
  });
});
