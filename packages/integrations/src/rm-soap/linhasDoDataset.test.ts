import { describe, expect, it } from 'vitest';
import { linhasDoDataset } from './wsConsultaSqlClient';

/**
 * Lista vazia é uma RESPOSTA, e não um lugar onde jogar a dúvida.
 *
 * ─── AS FORMAS SÃO MEDIDAS, NÃO SUPOSTAS ────────────────────────────────────
 *
 * Contra o RM da escola, em 14/09/2026, uma a uma:
 *
 *   Sentença inexistente   → SOAP Fault, com HTTP 200 (tratado antes daqui)
 *   parâmetro recusado     → SOAP Fault, com HTTP 200 (tratado antes daqui)
 *   ZERO linhas, legítimo  → exatamente a string `<NewDataSet />`
 *
 * A medição é o ponto: sem ela, "o que é vazio de verdade?" vira palpite, e o
 * palpite conservador (devolver `[]` sempre) é justamente o defeito. As duas
 * primeiras formas eu tinha anotado como silenciosas — não são; o cliente já
 * lança. A que sobrava é o dataset com conteúdo que não se chama `Resultado`.
 */
describe('linhasDoDataset', () => {
  it('`<NewDataSet />` é zero linhas, e passa', () => {
    expect(linhasDoDataset('<NewDataSet />', 'TODDLE.NOTAS')).toEqual([]);
  });

  it('lê as linhas e normaliza os valores para string aparada', () => {
    const xml = '<NewDataSet><Resultado><RA> 123 </RA><NOTA>7,5</NOTA></Resultado></NewDataSet>';
    expect(linhasDoDataset(xml, 'TODDLE.NOTAS')).toEqual([{ RA: '123', NOTA: '7,5' }]);
  });

  it('uma linha só continua vindo como array', () => {
    const xml = '<NewDataSet><Resultado><RA>1</RA></Resultado></NewDataSet>';
    expect(linhasDoDataset(xml, 'TODDLE.NOTAS')).toHaveLength(1);
  });

  // ─── o que ANTES virava `[]` em silêncio ───────────────────────────────────

  it('resposta sem dataset nenhum derruba, em vez de virar zero linhas', () => {
    expect(() => linhasDoDataset('', 'TODDLE.NOTAS')).toThrow(/SEM dataset/);
    expect(() => linhasDoDataset(null, 'TODDLE.NOTAS')).toThrow(/SEM dataset/);
  });

  it('XML que não é um dataset derruba, nomeando a raiz que veio', () => {
    expect(() => linhasDoDataset('<Erro><Msg>x</Msg></Erro>', 'TODDLE.NOTAS')).toThrow(/Erro/);
  });

  it('dataset com conteúdo que não se chama Resultado derruba, nomeando o achado', () => {
    // O caso que sobrava: a Sentença renomeou a linha, e o fluxo inteiro
    // concluiria "não há nota hoje".
    const xml = '<NewDataSet><Linha><RA>1</RA></Linha></NewDataSet>';
    expect(() => linhasDoDataset(xml, 'TODDLE.NOTAS')).toThrow(/\[Linha\]/);
  });

  it('a mensagem diz o código da Sentença — é por ele que se acha o cadastro', () => {
    expect(() => linhasDoDataset('', 'TODDLE.FREQ')).toThrow(/TODDLE\.FREQ/);
  });
});
