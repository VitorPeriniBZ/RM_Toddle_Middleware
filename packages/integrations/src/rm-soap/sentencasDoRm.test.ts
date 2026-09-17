import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SENTENCAS_DO_TODDLE,
  colunasDo,
  datasetDeGravacao,
  lerDoDisco,
  type SentencaNoDisco,
} from './sentencasDoRm';

/**
 * O que se testa aqui é o que decide, em silêncio, se a Sentença restaurada
 * volta CERTA — não se o SOAP responde.
 *
 * As duas armadilhas conhecidas não dão erro nenhum quando acontecem: um
 * `TAMANHO` que não corresponde ao corpo trunca o SQL, e uma coluna a menos na
 * execução chega no middleware como `undefined`, indistinguível de "o RM não
 * tem esse dado". Foram semanas de professor sem e-mail por causa da segunda.
 */

const PASTA = resolve(__dirname, '../../../../docs/rm-sentencas');

describe('colunasDo', () => {
  it('lê os apelidos do SELECT e para no primeiro FROM', () => {
    const corpo = ['SELECT A.RA        AS RA,', '       P.NOME      AS ALUNO', 'FROM SALUNO A', 'JOIN X AS Y'].join('\n');
    expect(colunasDo(corpo)).toEqual(['RA', 'ALUNO']);
  });

  /**
   * `CAST(:DATAINICIAL AS VARCHAR(8))` tem um `AS` que NÃO é apelido de coluna.
   * A `TODDLE.FREQ` e a `TODDLE.PLANOAULA` usam exatamente essa construção, e
   * confundi-la com coluna faria a conferência exigir uma coluna `VARCHAR` que
   * nunca vai voltar — reprovando para sempre uma Sentença boa.
   */
  it('não confunde o AS de um CAST com apelido de coluna', () => {
    const corpo = 'SELECT CAST(:DATAINICIAL AS VARCHAR(8)) AS INICIO\nFROM SFREQUENCIA';
    expect(colunasDo(corpo)).toEqual(['INICIO']);
  });

  it('devolve os apelidos em maiúsculas, porque a comparação com o RM é assim', () => {
    expect(colunasDo('SELECT a.x as email_professor\nFROM t')).toEqual(['EMAIL_PROFESSOR']);
  });
});

describe('as seis Sentenças do repositório', () => {
  it.each(SENTENCAS_DO_TODDLE)('%s tem .sql e entrada no manifesto', (codigo) => {
    const disco = lerDoDisco(codigo);
    expect(disco, `${codigo} não é restaurável a partir do repositório`).not.toBeNull();
    expect(disco!.corpo.length).toBeGreaterThan(200);
    expect(disco!.colunasEsperadas.length).toBeGreaterThan(5);
  });

  /**
   * O RM recusa `@NOME` no corpo da Sentença — é sintaxe do T-SQL, não do TOTVS.
   * A `TODDLE.FREQ` ficou meses com `@` por ter sido transcrita como T-SQL comum,
   * e isso só aparece na hora de colar.
   */
  it.each(SENTENCAS_DO_TODDLE)('%s usa :NOME e nunca @NOME', (codigo) => {
    const corpo = readFileSync(resolve(PASTA, `${codigo}.sql`), 'utf8');
    expect(corpo).not.toMatch(/@[A-Z_]{3,}/);
    expect(corpo).toMatch(/:CODCOLIGADA/);
  });

  /**
   * O RM normaliza o texto ao salvar e colapsa quebras de linha, o que faz um
   * `--` comentar até o fim da query. O save então falha com "Concurrency
   * violation", que não diz nada sobre comentário.
   */
  it.each(SENTENCAS_DO_TODDLE)('%s não tem comentário de linha', (codigo) => {
    expect(readFileSync(resolve(PASTA, `${codigo}.sql`), 'utf8')).not.toMatch(/--/);
  });
});

describe('datasetDeGravacao', () => {
  const sentenca = (corpo: string): SentencaNoDisco => ({
    codigo: 'TODDLE.RESP',
    corpo,
    metadados: { TITULO: 'T', PARAMETROS: [{ NOME: 'CODCOLIGADA', DESCRICAO: 'CODCOLIGADA', TIPO: 'System.Int16' }] },
    colunasEsperadas: colunasDo(corpo),
  });

  /**
   * O RM conta o corpo em CRLF — medido nas seis em 16/09/2026. Mandar o
   * tamanho em LF declara menos caracteres do que o texto tem, e é assim que o
   * SQL chega truncado sem ninguém ver.
   */
  it('declara TAMANHO contando CRLF, não LF', () => {
    const corpo = 'SELECT 1 AS UM\nFROM T\nWHERE X = :CODCOLIGADA';
    const xml = datasetDeGravacao(sentenca(corpo), 1);
    const tamanho = Number(/<TAMANHO>(\d+)<\/TAMANHO>/.exec(xml)![1]);
    expect(tamanho).toBe(corpo.replace(/\n/g, '\r\n').length);
    expect(tamanho).toBeGreaterThan(corpo.length);
  });

  /**
   * `GUID`, `CONTROLE` e as duas colunas de última alteração são geradas pelo
   * RM — conferido na sonda. Mandar as do manifesto plantaria o GUID de um
   * registro que não existe mais e a data de agosto num registro criado hoje.
   */
  it('não manda GUID, CONTROLE nem a última alteração', () => {
    const xml = datasetDeGravacao(sentenca('SELECT 1 AS UM\nFROM T'), 1);
    expect(xml).not.toMatch(/<GUID>/);
    expect(xml).not.toMatch(/<CONTROLE>/);
    expect(xml).not.toMatch(/<DTULTALTERACAO>/);
    expect(xml).not.toMatch(/<USRULTALTERACAO>/);
  });

  /**
   * `SEMSEGCOLUNAS` diferente de 0 faz o RM devolver MENOS colunas, sem erro.
   * É a razão de o manifesto existir, então tem de ir no dataset sempre.
   */
  it('manda as flags de segurança, que são o motivo do manifesto', () => {
    const xml = datasetDeGravacao(sentenca('SELECT 1 AS UM\nFROM T'), 1);
    expect(xml).toMatch(/<SEMSEGCOLUNAS>0<\/SEMSEGCOLUNAS>/);
    expect(xml).toMatch(/<SEMSEGESTENDIDA>0<\/SEMSEGESTENDIDA>/);
  });

  it('leva os parâmetros com o tipo que está no manifesto', () => {
    const xml = datasetDeGravacao(sentenca('SELECT 1 AS UM\nFROM T'), 1);
    expect(xml).toMatch(/<GConsSqlParams>[\s\S]*<NOME>CODCOLIGADA<\/NOME>/);
    expect(xml).toMatch(/<TIPO>System\.Int16<\/TIPO>/);
  });

  /**
   * `TIPO` nulo no manifesto é NULL no banco, e as seis EXECUTAM assim. Mandar
   * a tag vazia gravaria string vazia, que é outro valor — e "consertar" isso
   * junto de uma restauração mistura dois riscos diferentes.
   */
  it('omite o elemento do parâmetro cujo TIPO é NULL, em vez de mandar vazio', () => {
    const s: SentencaNoDisco = {
      ...sentenca('SELECT 1 AS UM\nFROM T'),
      metadados: { PARAMETROS: [{ NOME: 'CODPERLET', DESCRICAO: 'CODPERLET', TIPO: null }] },
    };
    const xml = datasetDeGravacao(s, 1);
    expect(xml).toMatch(/<NOME>CODPERLET<\/NOME>/);
    expect(xml).not.toMatch(/<TIPO>/);
  });

  it('escapa o corpo, porque todo .sql tem < e >', () => {
    const xml = datasetDeGravacao(sentenca('SELECT 1 AS UM\nFROM T WHERE A <> 2'), 1);
    expect(xml).toMatch(/&lt;&gt;/);
  });
});
