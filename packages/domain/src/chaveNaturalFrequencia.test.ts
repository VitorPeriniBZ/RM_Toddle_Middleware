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

  it('casa independentemente dos campos que só existem do lado do RM', () => {
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

  describe('duas aulas diferentes NUNCA casam', () => {
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
  const fonte = readFileSync(resolve(__dirname, 'rmAttendanceSource.ts'), 'utf8');

  it('chama chaveNaturalRm em vez de montar a string por conta própria', () => {
    const corpo = /export function chaveNaturalDeFalta[\s\S]*?\n}/.exec(fonte)?.[0] ?? '';

    expect(corpo, 'não encontrei a função chaveNaturalDeFalta em rmAttendanceSource.ts').not.toBe(
      '',
    );
    expect(
      corpo,
      'chaveNaturalDeFalta parou de chamar chaveNaturalRm. Há agora DUAS fórmulas para a mesma ' +
        'chave, e o dia em que elas divergirem o cruzamento não casa nada: tudo vira ' +
        'ESCREVER_NOVO e a proteção contra sobrescrever lançamento de professor se desliga em ' +
        'silêncio, com o relatório parecendo normal. Ver o comentário na própria função.',
    ).toContain('chaveNaturalRm(');
    expect(
      corpo,
      'chaveNaturalDeFalta passou a montar a chave com join() próprio. Ver acima.',
    ).not.toMatch(/\.join\(/);
  });

  it('importa a fórmula do módulo da projeção', () => {
    expect(fonte).toMatch(/import\s*\{[^}]*chaveNaturalRm[^}]*\}\s*from\s*'\.\/attendanceProjection'/);
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

describe('MODO DE FALHA — comportamento ATUAL, a corrigir no P0-6', () => {
  /**
   * ATENÇÃO, quem estiver lendo: os testes deste bloco PASSAM, e o que eles
   * descrevem é o defeito. Eles não estão aqui para aprovar o comportamento, e
   * sim para que a mudança do P0-6 tenha de encará-los explicitamente em vez de
   * alterar o sistema sem perceber o que estava alterando.
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

  it('coluna ausente vira segmento VAZIO na chave, em vez de erro', () => {
    expect(chaveNaturalDeFalta(falta({ idTurmaDisc: '' }))).toBe(
      '1|48211||2023100234|2026-09-01',
    );
  });

  it('duas colunas ausentes viram dois segmentos vazios', () => {
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
  it('a chave degradada NÃO casa com a projetada — é por aqui que a trava se desliga', () => {
    const doRm = chaveNaturalDeFalta(falta({ idTurmaDisc: '' }));
    const desejada = chaveNaturalRm(linha());
    expect(doRm).not.toBe(desejada);
  });

  it('com a coluna ausente, NENHUMA falta do RM é encontrada no índice', () => {
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
   * ─── O QUE O P0-6 TEM DE FAZER ────────────────────────────────────────────
   *
   * Este teste está desligado DE PROPÓSITO. Ele descreve o comportamento
   * desejado, não o atual, e é o critério de aceite do P0-6.
   *
   * TODO(P0-6): trocar o `?? ''` de rmAttendanceSource.ts:210-212 por falha
   * alta, no LEITOR — antes de qualquer veredito, para que o run aborte inteiro
   * em vez de escrever parte das linhas. Atrás da flag
   * `FALHA_ALTA_EM_COLUNA_AUSENTE`, default false, com período de sombra antes
   * de ligar. Quando isso estiver pronto, remover o `.skip` e apagar o bloco
   * "comportamento ATUAL" acima.
   */
  it.skip('P0-6: coluna ausente deve ERRAR, nunca produzir chave com segmento vazio', () => {
    expect(() => chaveNaturalDeFalta(falta({ idTurmaDisc: '' }))).toThrow(/ID_TURMADISC|ausente/i);
  });
});
