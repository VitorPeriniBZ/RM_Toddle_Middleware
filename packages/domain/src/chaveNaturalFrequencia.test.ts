import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chaveNaturalRm, type LinhaFrequencia } from './attendanceProjection';
import { chaveNaturalDeFalta, indexaFaltasPorChave, type RmFalta } from './rmAttendanceSource';

/**
 * A CHAVE NATURAL DA FREQUÊNCIA, CONGELADA.
 *
 * ─── POR QUE ESTE ARQUIVO EXISTE ────────────────────────────────────────────
 *
 * `decidirEscrita` é a trava que impede a integração de apagar lançamento de
 * professor, e ela tem 15 testes. Mas a trava só funciona se o cruzamento casar
 * a LINHA CERTA, e o casamento é por esta chave. Até aqui ela tinha ZERO testes:
 * a proteção estava verificada, e o que faz a proteção apontar para o lugar
 * certo não estava.
 *
 * O autor de `rmAttendanceSource.ts` já havia escrito o modo de falha, em
 * prosa, no comentário de `chaveNaturalDeFalta`:
 *
 *   "Se as duas fórmulas divergirem — uma vírgula, uma ordem de campo, um
 *    codColigada como "1" contra 1 — o cruzamento não casa NADA. E o modo de
 *    falha é o pior possível: tudo aparece como ESCREVER_NOVO, a proteção
 *    contra sobrescrever lançamento humano SE DESLIGA EM SILÊNCIO, e o
 *    relatório fica bonito."
 *
 * Comentário não impede regressão — este arquivo impede. Ele não conserta nada:
 * congela o comportamento ATUAL, exatamente como está hoje, para que a mudança
 * do P0-6 seja feita sobre uma rede em vez de no escuro.
 *
 * ─── O QUE ESTE ARQUIVO NÃO FAZ ─────────────────────────────────────────────
 *
 * Não corrige o `?? ''` de `rmAttendanceSource.ts:210-212`. O defeito está
 * DOCUMENTADO abaixo, em testes que passam porque descrevem o que o código faz
 * hoje — inclusive o que ele faz de errado. O conserto é o P0-6, e o teste que
 * vai exigi-lo já está escrito aqui, em `it.skip`.
 */

// ─── FIXTURAS ───────────────────────────────────────────────────────────────
//
// Valores plausíveis de verdade: RA e IDTURMADISC no formato que a Sentença
// TODDLE.FREQ devolve. Os helpers existem para que um teste declare só o campo
// que lhe interessa — quando um teste precisa mudar o IDTURMADISC, é o
// IDTURMADISC que tem de saltar aos olhos, não as outras oito linhas.

const linhaBase: LinhaFrequencia = {
  codColigada: 1,
  idHorarioTurma: '48211',
  idTurmaDisc: '1714',
  ra: '2023100234',
  data: '2026-09-01',
  presenca: 'A',
};

const faltaBase: RmFalta = {
  codColigada: '1',
  ra: '2023100234',
  idTurmaDisc: '1714',
  data: '2026-09-01',
  idHorarioTurma: '48211',
  presenca: 'A',
  justificada: false,
  codFilial: '2',
  criadoPelaIntegracao: false,
  autorHash: 'a1b2c3d4e5f60718',
  alteradaDepoisDeCriada: false,
};

const linha = (mudancas: Partial<LinhaFrequencia> = {}): LinhaFrequencia => ({
  ...linhaBase,
  ...mudancas,
});

const falta = (mudancas: Partial<RmFalta> = {}): RmFalta => ({ ...faltaBase, ...mudancas });

// ─── O CONTRATO ─────────────────────────────────────────────────────────────

describe('formato da chave — contrato congelado', () => {
  /**
   * O teste mais importante do arquivo, e o mais bobo de escrever.
   *
   * A string literal ABAIXO é o contrato. Qualquer mudança no formato — ordem
   * dos segmentos, separador, um campo a mais, um `String()` no lugar errado —
   * faz esta linha falhar, e é isso que se quer: a chave só pode mudar de
   * propósito, num commit que diga que está mudando.
   *
   * Mudar a chave sem migrar a proveniência já gravada em `rm_write_provenance`
   * faria TODA linha existente virar "nunca escrevemos isto", que é a mesma
   * consequência do defeito que este arquivo protege.
   */
  it('é [codColigada|idHorarioTurma|idTurmaDisc|ra|data], separada por barra vertical', () => {
    expect(chaveNaturalRm(linha())).toBe('1|48211|1714|2023100234|2026-09-01');
  });

  it('tem exatamente 5 segmentos, nesta ordem', () => {
    const partes = chaveNaturalRm(linha()).split('|');
    expect(partes).toEqual(['1', '48211', '1714', '2023100234', '2026-09-01']);
  });

  /**
   * `presenca` e `justificada` NÃO entram na chave, e isso é desenho, não
   * esquecimento: a chave identifica a AULA-ALUNO, e o valor da presença é o que
   * se compara depois. Se a presença entrasse aqui, mudar de 'A' para 'P' viraria
   * "linha nova" e `decidirEscrita` nunca veria o conflito — a trava inteira
   * perderia sentido.
   */
  it('NÃO inclui a presença: a chave identifica a aula-aluno, não o valor', () => {
    expect(chaveNaturalRm(linha({ presenca: 'A' }))).toBe(chaveNaturalRm(linha({ presenca: 'P' })));
  });

  it('NÃO inclui a justificativa', () => {
    expect(chaveNaturalRm(linha({ justificada: 'S' }))).toBe(chaveNaturalRm(linha()));
  });

  describe('cada um dos 5 segmentos participa da identidade', () => {
    // Se um campo parar de compor a chave, duas aulas diferentes passam a casar
    // como a mesma, e a escrita de uma sobrescreve a leitura da outra.
    const casos: Array<[string, Partial<LinhaFrequencia>]> = [
      ['codColigada', { codColigada: 2 }],
      ['idHorarioTurma', { idHorarioTurma: '48212' }],
      ['idTurmaDisc', { idTurmaDisc: '1715' }],
      ['ra', { ra: '2023100235' }],
      ['data', { data: '2026-09-02' }],
    ];

    for (const [campo, mudanca] of casos) {
      it(`mudar ${campo} muda a chave`, () => {
        expect(chaveNaturalRm(linha(mudanca))).not.toBe(chaveNaturalRm(linha()));
      });
    }
  });
});

// ─── A SIMETRIA ENTRE OS DOIS LADOS ─────────────────────────────────────────

describe('os dois lados produzem a MESMA chave para o mesmo fato', () => {
  /**
   * Este é o invariante que a prosa do autor descreve. O lado DESEJADO monta a
   * chave a partir de `LinhaFrequencia` (projetada do Toddle); o lado do RM monta
   * a partir de `RmFalta` (lida por Sentença). São tipos diferentes, vindos de
   * sistemas diferentes, e têm de colidir exatamente.
   */
  it('a falta do RM e a linha projetada casam', () => {
    expect(chaveNaturalDeFalta(falta())).toBe(chaveNaturalRm(linha()));
  });

  /**
   * O caso que o comentário do autor cita nominalmente: `"1"` contra `1`.
   *
   * `RmFalta.codColigada` é `string` (vem do XML) e `LinhaFrequencia.codColigada`
   * é `number`. Sem a coerção `Number()` em `chaveNaturalDeFalta`, o lado do RM
   * produziria a mesma string por coincidência de `Array.join` — mas a coerção
   * é o que garante isso quando o RM devolver `"01"` ou `" 1"`.
   */
  it('coage codColigada de string para número: "1" casa com 1', () => {
    expect(chaveNaturalDeFalta(falta({ codColigada: '1' }))).toBe(
      chaveNaturalRm(linha({ codColigada: 1 })),
    );
  });

  it('coage codColigada com zero à esquerda: "01" casa com 1', () => {
    expect(chaveNaturalDeFalta(falta({ codColigada: '01' }))).toBe(
      chaveNaturalRm(linha({ codColigada: 1 })),
    );
  });

  it('coage codColigada com espaço: " 1 " casa com 1', () => {
    expect(chaveNaturalDeFalta(falta({ codColigada: ' 1 ' }))).toBe(
      chaveNaturalRm(linha({ codColigada: 1 })),
    );
  });

  /**
   * A presença diverge entre os dois lados o tempo todo — é exatamente o que a
   * comparação quer descobrir. Se ela entrasse na chave, nada casaria justamente
   * nos casos que importam.
   */
  it('casa mesmo quando a presença diverge — que é o caso interessante', () => {
    expect(chaveNaturalDeFalta(falta({ presenca: 'A' }))).toBe(
      chaveNaturalRm(linha({ presenca: 'P' })),
    );
  });

  /**
   * Acrescentar campo a `RmFalta` não pode mudar a chave.
   *
   * O nome anterior deste teste era "casa independentemente dos campos que só
   * existem do lado do RM", o que era tautológico: a chave lê 5 campos, é
   * impossível falhar. O valor real dele é outro e é prospectivo — ele falha no
   * dia em que alguém ACRESCENTAR um desses campos à chave (`codHor` é o
   * candidato óbvio), que é uma mudança plausível e que quebraria toda a
   * proveniência já gravada.
   */
  it('acrescentar campo a RmFalta não muda a chave', () => {
    const comExtras = falta({
      codHor: 'SEG-0800',
      faixa: '1',
      diaSemana: '2',
      horaInicial: '08:00',
      horaFinal: '08:50',
      codTurma: '9A',
      codDisc: 'MAT',
      criadoEm: '2026-09-01T10:00:00',
      alteradoEm: '2026-09-01T10:00:00',
      justificativa: 'Atestado',
    });
    expect(chaveNaturalDeFalta(comExtras)).toBe(chaveNaturalRm(linha()));
  });

  /**
   * O nome deste bloco já foi "duas aulas diferentes NUNCA casam", e o "NUNCA"
   * era falso — o próprio arquivo o desmente mais abaixo: sob a degradação do
   * `?? ''`, duas aulas distintas colapsam na MESMA chave. Cinco mutações de
   * campo único sobre um fixture fixo não provam "nunca"; provam isto aqui.
   */
  describe('mudar um campo separa as chaves', () => {
    const casos: Array<[string, Partial<RmFalta>, Partial<LinhaFrequencia>]> = [
      ['outro aluno', { ra: '2023100235' }, {}],
      ['outra turma-disciplina', { idTurmaDisc: '1715' }, {}],
      ['outro horário', { idHorarioTurma: '48212' }, {}],
      ['outra data', { data: '2026-09-02' }, {}],
      ['outra coligada', { codColigada: '2' }, {}],
    ];

    for (const [nome, noRm, noDesejado] of casos) {
      it(nome, () => {
        expect(chaveNaturalDeFalta(falta(noRm))).not.toBe(chaveNaturalRm(linha(noDesejado)));
      });
    }
  });
});

// ─── O QUE A CHAVE EXIGE DE QUEM A ALIMENTA ─────────────────────────────────

describe('pré-condições que a chave NÃO verifica, e de quem depende', () => {
  /**
   * A chave é um `join`. Ela não normaliza nada além do `Number()` da coligada —
   * confia em quem a alimenta. Estes testes documentam de QUEM ela depende, para
   * que a dependência seja visível em vez de suposta.
   *
   * Verificado no código: quem garante cada pré-condição é o LEITOR,
   * `fetchFrequenciaFromRm`, e não esta função:
   *
   *   data      `toIsoDate(pick(row, 'DATA'))` em rmAttendanceSource.ts:201,
   *             e linha ilegível é DESCARTADA com warn (`continue`).
   *   espaços   `trimValues: true` nos dois parsers XML
   *             (wsConsultaSqlClient.ts:71 e wsDataServerClient.ts:78).
   *
   * Se qualquer uma dessas duas garantias sair de lugar, o sintoma não é erro:
   * é o cruzamento parar de casar, silenciosamente. Por isso valem teste aqui,
   * onde a consequência mora.
   */

  it('data em formato do RM NÃO casa — quem normaliza é o leitor, não a chave', () => {
    // O que aconteceria se `toIsoDate` saísse do caminho de leitura.
    const semNormalizar = chaveNaturalDeFalta(falta({ data: '2026-09-01T00:00:00' }));
    expect(semNormalizar).not.toBe(chaveNaturalRm(linha()));
  });

  it('data em formato brasileiro NÃO casa — idem', () => {
    expect(chaveNaturalDeFalta(falta({ data: '01/09/2026' }))).not.toBe(chaveNaturalRm(linha()));
  });

  it('espaço em volta do RA NÃO casa — quem apara é o parser XML', () => {
    expect(chaveNaturalDeFalta(falta({ ra: ' 2023100234 ' }))).not.toBe(chaveNaturalRm(linha()));
  });

  it('espaço em volta do IDTURMADISC NÃO casa — idem', () => {
    expect(chaveNaturalDeFalta(falta({ idTurmaDisc: ' 1714 ' }))).not.toBe(
      chaveNaturalRm(linha()),
    );
  });

  /**
   * A coerção que os testes de simetria celebram é também um caminho de
   * corrupção, e vale registrar antes que alguém a use como garantia.
   *
   * `Number('')` é `0` — e `0` pode ser uma coligada legítima em outra
   * instalação do RM. `Number('X')` é `NaN`, que vira a string `'NaN'`.
   * Nos dois casos a chave sai FORMADA, com cara de válida.
   */
  it('[CHAVE CRUA] coligada vazia vira 0, não erro', () => {
    expect(chaveNaturalDeFalta(falta({ codColigada: '' }))).toBe(
      '0|48211|1714|2023100234|2026-09-01',
    );
  });

  it('[CHAVE CRUA] coligada não numérica vira NaN, não erro', () => {
    expect(chaveNaturalDeFalta(falta({ codColigada: 'X' }))).toBe(
      'NaN|48211|1714|2023100234|2026-09-01',
    );
  });
});

// ─── UMA FÓRMULA, NÃO DUAS ──────────────────────────────────────────────────

describe('chaveNaturalDeFalta não reimplementa a fórmula', () => {
  /**
   * Teste estrutural, no mesmo espírito de `suiteSerializada.test.ts`.
   *
   * Os testes de simetria acima provam que hoje as duas chaves batem. O que eles
   * NÃO conseguem provar é que continuarão batendo: se alguém reescrever
   * `chaveNaturalDeFalta` com um `join` próprio "para não depender do outro
   * módulo", os testes de simetria continuam verdes até o dia em que alguém
   * mexer num dos dois lados — e aí voltam as DUAS fórmulas que o comentário do
   * autor pede para nunca existirem.
   *
   * Por isso este teste olha para o código, e não para o resultado.
   */
  const fonteCrua = readFileSync(resolve(__dirname, 'rmAttendanceSource.ts'), 'utf8');

  /**
   * Comentários saem ANTES de qualquer asserção; strings FICAM.
   *
   * Sem tirar comentários, a asserção positiva é satisfeita por um
   * `chaveNaturalRm(` escrito dentro de um comentário — e o comentário da
   * própria função menciona a fórmula. O teste passaria exatamente no cenário
   * que ele existe para pegar.
   *
   * Tirar as STRINGS, por outro lado, seria um erro: é o conteúdo da string que
   * distingue `join('|')` (montar a chave) de `join(', ')` (formatar uma
   * mensagem de erro). Neutralizá-las tornaria a proibição de `join` ampla de
   * novo — que é justamente o falso vermelho que este bloco quer evitar.
   */
  const semComentarios = fonteCrua
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  /**
   * Aceita as DUAS formas de declaração.
   *
   * `chaveNaturalDeFalta` é `export function` hoje, mas `chaveNaturalRm`, no
   * módulo vizinho, é `export const … =>`. Padronizar o estilo é uma mudança
   * cosmética plausível, e um teste que quebra por causa dela gasta a confiança
   * de quem o lê — da próxima vez ele é desligado em vez de investigado.
   */
  const corpoDaFuncao = (fonte: string): string =>
    /export\s+(?:function\s+chaveNaturalDeFalta|const\s+chaveNaturalDeFalta\s*(?::[^=]+)?=)[\s\S]*?\n}/.exec(
      fonte,
    )?.[0] ?? '';

  it('chama chaveNaturalRm em vez de montar a string por conta própria', () => {
    const corpo = corpoDaFuncao(semComentarios);

    expect(
      corpo,
      'não encontrei a declaração de chaveNaturalDeFalta em rmAttendanceSource.ts. Se ela foi ' +
        'renomeada ou movida, este teste precisa acompanhar — não o apague: ele é a única ' +
        'barreira contra a fórmula da chave ser duplicada.',
    ).not.toBe('');

    expect(
      corpo,
      'chaveNaturalDeFalta parou de chamar chaveNaturalRm. Há agora DUAS fórmulas para a mesma ' +
        'chave, e o dia em que elas divergirem o cruzamento não casa nada: tudo vira ' +
        'ESCREVER_NOVO e a proteção contra sobrescrever lançamento de professor se desliga em ' +
        'silêncio, com o relatório parecendo normal. Ver o comentário na própria função.',
    ).toContain('chaveNaturalRm(');

    /*
     * A proibição é do SEPARADOR, não de `join`.
     *
     * A versão anterior proibia qualquer `.join(`, e isso teria dado falso
     * vermelho no próprio P0-6: a mensagem de erro que ele vai adicionar aqui
     * provavelmente lista as colunas ausentes com `join(', ')`. Proibir
     * `join('|')` mira o que de fato caracteriza uma reimplementação da chave —
     * uma mensagem de erro não usa a barra vertical.
     */
    expect(
      corpo,
      "chaveNaturalDeFalta passou a montar a chave com join('|') próprio. Ver acima.",
    ).not.toMatch(/\.join\(\s*['"`]\|['"`]\s*\)/);
  });

  it('importa a fórmula do módulo da projeção', () => {
    expect(semComentarios).toMatch(
      /import\s*\{[^}]*chaveNaturalRm[^}]*\}\s*from\s*'\.\/attendanceProjection'/,
    );
  });
});

// ─── O ÍNDICE ───────────────────────────────────────────────────────────────

describe('indexaFaltasPorChave', () => {
  it('indexa pela mesma chave que a projeção usa', () => {
    const indice = indexaFaltasPorChave([falta()]);
    expect(indice.has(chaveNaturalRm(linha()))).toBe(true);
  });

  it('guarda uma entrada por aula-aluno', () => {
    const indice = indexaFaltasPorChave([
      falta(),
      falta({ ra: '2023100235' }),
      falta({ data: '2026-09-02' }),
    ]);
    expect(indice.size).toBe(3);
  });

  it('aguenta lista vazia', () => {
    expect(indexaFaltasPorChave([]).size).toBe(0);
  });

  /**
   * Comportamento ATUAL, registrado sem juízo de valor: com chave repetida, a
   * última linha vence. Hoje isso não deveria acontecer — a Sentença devolve uma
   * linha por aula-aluno — mas se um dia acontecer, é assim que se comporta, e
   * quem for investigar merece encontrar isto escrito.
   */
  it('com chave repetida, a última linha lida vence', () => {
    const indice = indexaFaltasPorChave([
      falta({ presenca: 'A' }),
      falta({ presenca: 'P' }), // mesma chave: presença não participa dela
    ]);
    expect(indice.size).toBe(1);
    expect(indice.get(chaveNaturalRm(linha()))?.presenca).toBe('P');
  });
});

// ─── O MODO DE FALHA ────────────────────────────────────────────────────────

describe('A CHAVE É CRUA — e quem a protege está acima dela', () => {
  /**
   * Este bloco descrevia "o defeito, a corrigir no P0-6". O P0-6 foi feito, e
   * o comportamento aqui NÃO mudou — mudou o entendimento de onde ele é
   * problema.
   *
   * `chaveNaturalRm` é um `join`. Dar a ela um componente vazio produz uma
   * chave degradada, e isso continua verdade. O que mudou é que agora nada
   * chega aqui nesse estado: o leitor detecta coluna ausente do result set
   * ANTES do laço (`colunasDaChaveAusentes`) e descarta a linha quando o valor
   * vem vazio, do mesmo jeito que já fazia com `DATA` ilegível.
   *
   * Os testes seguem valendo, e por uma razão que ficou mais forte: eles
   * documentam o que acontece se alguém construir um `RmFalta` por outro
   * caminho — um script, um teste, um fluxo novo — sem passar pelo leitor.
   *
   * O gatilho não é hipotético neste projeto. As Sentenças SQL moram DENTRO do
   * RM e são apagadas por toda cópia de base (13-15/08, 16/09 e 20/09/2026). O
   * restauro automático recoloca a versão do repositório git, que pode estar
   * ATRÁS da que estava no RM. Ou seja: uma coluna pode sumir do result set sem
   * ninguém tocar em uma linha de código deste repositório.
   *
   * Quando isso acontece, `rmAttendanceSource.ts:210-212` faz:
   *
   *     idTurmaDisc:    pick(row, 'ID_TURMADISC', 'IDTURMADISC') ?? '',
   *     idHorarioTurma: pick(row, 'ID_HORARIO_TURMA', 'IDHORARIOTURMA') ?? '',
   *
   * O `?? ''` converte "a coluna sumiu" em "o valor é vazio", que é uma mentira
   * silenciosa: o RM não disse que a turma-disciplina é vazia, ele não disse nada.
   */

  it('[CHAVE CRUA] coluna ausente vira segmento VAZIO na chave, em vez de erro', () => {
    expect(chaveNaturalDeFalta(falta({ idTurmaDisc: '' }))).toBe(
      '1|48211||2023100234|2026-09-01',
    );
  });

  it('[CHAVE CRUA] duas colunas ausentes viram dois segmentos vazios', () => {
    expect(chaveNaturalDeFalta(falta({ idTurmaDisc: '', idHorarioTurma: '' }))).toBe(
      '1|||2023100234|2026-09-01',
    );
  });

  /**
   * A consequência, em uma linha: a chave degradada não casa com a projetada.
   *
   * No cruzamento de `sincronizarFrequencia.ts`, "não achei a linha no RM" é
   * `ESCREVER_NOVO` — o caminho que AUTORIZA a escrita. A falta lançada pelo
   * professor continua lá, o sistema simplesmente não a enxerga, e escreve por
   * cima achando que o RM estava vazio.
   */
  it('[CHAVE CRUA] a chave degradada NÃO casa com a projetada — a trava se desliga aqui', () => {
    const doRm = chaveNaturalDeFalta(falta({ idTurmaDisc: '' }));
    const desejada = chaveNaturalRm(linha());
    expect(doRm).not.toBe(desejada);
  });

  /**
   * ─── PIOR QUE NÃO ENCONTRAR: PERDER ──────────────────────────────────────
   *
   * O caso acima é um miss — a falta do RM existe e não é vista. Existe um caso
   * pior, e ele só aparece com dados realistas.
   *
   * O mesmo aluno, no mesmo dia, tem duas aulas: matemática no 1º horário e
   * português no 2º. As duas linhas diferem SOMENTE por `idTurmaDisc` e
   * `idHorarioTurma` — que são exatamente as duas colunas que o `?? ''`
   * degrada. Com as duas ausentes, as duas aulas colapsam na MESMA chave, e
   * `indexaFaltasPorChave` descarta uma ("a última vence").
   *
   * A linha não é só invisível: ela some do índice. E `indice.size` menor que a
   * quantidade de faltas lidas é um sinal observável que hoje ninguém afirma em
   * lugar nenhum — é candidato a virar alerta no P0-5.
   */
  it('[CHAVE CRUA] duas aulas do mesmo aluno no mesmo dia colapsam numa chave só', () => {
    const matematica = falta({ idTurmaDisc: '', idHorarioTurma: '', presenca: 'A' });
    const portugues = falta({ idTurmaDisc: '', idHorarioTurma: '', presenca: 'P' });

    expect(chaveNaturalDeFalta(matematica)).toBe(chaveNaturalDeFalta(portugues));

    const indice = indexaFaltasPorChave([matematica, portugues]);
    expect(
      indice.size,
      'duas faltas entraram e o índice ficou com uma: a outra foi descartada em silêncio',
    ).toBe(1);
  });

  it('[CHAVE CRUA] com a coluna ausente, NENHUMA falta do RM é encontrada no índice', () => {
    // O cenário real: a Sentença perdeu ID_TURMADISC, então TODAS as linhas
    // lidas do RM ficam com o segmento vazio — e o índice inteiro fica inútil.
    const doRm = [
      falta({ idTurmaDisc: '', ra: '2023100234' }),
      falta({ idTurmaDisc: '', ra: '2023100235' }),
      falta({ idTurmaDisc: '', ra: '2023100236' }),
    ];
    const indice = indexaFaltasPorChave(doRm);

    const procuradas = [
      chaveNaturalRm(linha({ ra: '2023100234' })),
      chaveNaturalRm(linha({ ra: '2023100235' })),
      chaveNaturalRm(linha({ ra: '2023100236' })),
    ];

    const encontradas = procuradas.filter((c) => indice.has(c));
    expect(
      encontradas,
      'se algum dia isto encontrar alguma, o modo de falha mudou e este bloco precisa ser relido',
    ).toHaveLength(0);

    // O índice se monta normalmente — 3 linhas, 3 entradas. É isso que torna a
    // falha tão difícil de ver: nada parece quebrado do lado do RM. As chaves
    // existem, são distintas, o Map está saudável. Elas só não correspondem a
    // nada que a projeção vá procurar.
    expect(indice.size).toBe(3);
  });

  /**
   * ─── O CRITÉRIO DE ACEITE MUDOU DE LUGAR, E ISSO É UMA CORREÇÃO ───────────
   *
   * Este teste era um `it.fails` afirmando que `chaveNaturalDeFalta` passaria a
   * LANÇAR quando um componente viesse vazio. O P0-6 foi feito e ele NÃO lança
   * — e a razão é que o critério que escrevi no P0-1 apontava para o lugar
   * errado.
   *
   * A revisão do conselho disse, sobre a blindagem do P0-6: "fail-high no
   * LEITOR, não no comparador — falhar na montagem da linha, antes de qualquer
   * veredito, para o run abortar inteiro em vez de escrever parte das linhas".
   * Estava certa, e por um motivo que só fica visível com o código na frente:
   *
   *   coluna ausente do RESULT SET   é drift da Sentença. Vale para TODAS as
   *                                  linhas. O lugar de detectar é UMA vez,
   *                                  antes do laço — `colunasDaChaveAusentes`.
   *   valor vazio numa LINHA         é registro incompleto. Vale para uma.
   *                                  A linha é descartada, como a `DATA`
   *                                  ilegível já era.
   *
   * `chaveNaturalRm` é um `join` puro, chamada depois de as duas checagens já
   * terem acontecido. Fazê-la lançar seria uma terceira guarda no lugar mais
   * quente do laço, para um estado que o leitor já não deixa passar.
   *
   * Registro em vez de apagar porque o raciocínio errado é a parte útil: o
   * `it.fails` cumpriu o papel de forçar esta conversa no momento do conserto,
   * que era exatamente o desenho.
   *
   * ONDE O CRITÉRIO VIVE AGORA:
   *   packages/domain/src/colunasDaChaveAusentes.test.ts  (a detecção)
   *   FALHA_ALTA_EM_COLUNA_AUSENTE em env.ts              (sombra × estrito)
   */
  it('a chave continua sendo um join puro — quem barra o vazio é o leitor', () => {
    // Comportamento ATUAL e deliberado: ela não valida, e não deve.
    expect(chaveNaturalDeFalta(falta({ idTurmaDisc: '' }))).toBe(
      '1|48211||2023100234|2026-09-01',
    );
  });
});
