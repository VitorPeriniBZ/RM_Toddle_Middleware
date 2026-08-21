import { decidirEscrita, hashValor, resumirDecisoes } from '@rm-toddle/domain';
import type { Decisao, EstadoNoRm, Proveniencia, Veredito } from '@rm-toddle/domain';

/**
 * Verifica a regra que impede a integração de apagar trabalho humano.
 *
 *   npm run teste:decisao
 *
 * Não toca RM, Toddle nem banco — a decisão é pura de propósito, justamente para
 * poder ser exercitada assim.
 *
 * ─── POR QUE ESTE TESTE EXISTE ──────────────────────────────────────────────
 *
 * Um erro aqui não aparece como exceção nem como log de erro. Aparece como
 * ausência apagada no diário de um aluno, ou conteúdo de aula de um professor
 * sobrescrito — semanas depois, sem rastro, num sistema que é registro
 * acadêmico legal de 300 alunos. É a classe de defeito que nenhum monitor pega.
 */

const USUARIO = 'integracao.toddle';
let falhas = 0;

function caso(
  nome: string,
  esperado: Veredito,
  desejado: string | null,
  noRm: EstadoNoRm | null,
  prov: Proveniencia | null,
  /**
   * `null` = a integração NÃO tem usuário configurado.
   *
   * Não usar `undefined` aqui: passar `undefined` a um parâmetro com valor
   * default aciona o default, então o caso "sem usuário" silenciosamente virava
   * "com usuário" e o teste passava por engano. Foi o que aconteceu na primeira
   * execução deste arquivo.
   */
  usuario: string | null = USUARIO,
): Decisao {
  const d = decidirEscrita(
    { chaveNatural: 'k', valor: desejado },
    noRm,
    prov,
    usuario ?? undefined,
  );
  const ok = d.veredito === esperado;
  if (!ok) falhas += 1;
  console.log(`  ${ok ? 'ok  ' : 'FALHA'} ${nome}`);
  if (!ok) console.log(`         esperado ${esperado}, veio ${d.veredito} — ${d.porque}`);
  return d;
}

const nosso = (valor: string): Proveniencia => ({
  payloadHash: hashValor(valor),
  escritoEm: '2026-08-20T03:00:00.000Z',
});

console.log('\n── caminho normal ────────────────────────────────────────────');
caso('RM vazio, nunca escrevemos -> escreve', 'ESCREVER_NOVO', 'A', null, null);
caso('RM vazio (string vazia) conta como ausente', 'ESCREVER_NOVO', 'A', { valor: '' }, null);
caso('RM vazio (só espaço) conta como ausente', 'ESCREVER_NOVO', 'A', { valor: '   ' }, null);
caso('RM já tem o mesmo valor -> não gasta chamada', 'NADA_A_FAZER', 'A', { valor: 'A' }, null);
caso(
  'nosso, intacto, origem mudou -> atualiza',
  'ATUALIZAR_NOSSO',
  'Revisão de frações',
  { valor: 'Frações' },
  nosso('Frações'),
);

console.log('\n── proteção do trabalho humano ───────────────────────────────');
caso(
  'RM preenchido por humano, sem proveniência -> CONFLITO',
  'CONFLITO_HUMANO',
  'A',
  { valor: 'P', alteradoPor: '10952118700' },
  null,
);
caso(
  'RM preenchido, autoria desconhecida -> CONFLITO (fail-closed)',
  'CONFLITO_HUMANO',
  'A',
  { valor: 'P' },
  null,
);
caso(
  'nosso, mas o RM tem outro valor -> alguém editou depois',
  'EDITADO_POR_FORA',
  'Frações',
  { valor: 'Frações e decimais', alteradoPor: '05915960758' },
  nosso('Frações'),
);

console.log('\n── remoção nunca é inferida ──────────────────────────────────');
caso(
  'saiu do Toddle mas existe no RM -> pede humano',
  'REMOCAO_PEDE_HUMANO',
  null,
  { valor: 'A' },
  nosso('A'),
);
caso('saiu do Toddle e já não existe no RM -> nada', 'NADA_A_FAZER', null, { valor: null }, null);
caso('saiu do Toddle, RM nunca teve -> nada', 'NADA_A_FAZER', null, null, null);

console.log('\n── recuperação após restauração do NOSSO banco ───────────────');
caso(
  'sem proveniência, mas o RM diz que o autor é a integração -> atualiza',
  'ATUALIZAR_NOSSO',
  'A',
  { valor: 'P', alteradoPor: USUARIO },
  null,
);
caso(
  'idem, autoria só em RECCREATEDBY',
  'ATUALIZAR_NOSSO',
  'A',
  { valor: 'P', criadoPor: USUARIO },
  null,
);
caso(
  'autor com espaço em volta ainda é reconhecido',
  'ATUALIZAR_NOSSO',
  'A',
  { valor: 'P', alteradoPor: ` ${USUARIO} ` },
  null,
);
caso(
  'ALTERADO_POR humano vence CRIADO_POR da integração',
  'CONFLITO_HUMANO',
  'A',
  { valor: 'P', criadoPor: USUARIO, alteradoPor: '10952118700' },
  null,
);
caso(
  'sem usuário de integração configurado -> fail-closed',
  'CONFLITO_HUMANO',
  'A',
  { valor: 'P', alteradoPor: USUARIO },
  null,
  null,
);

console.log('\n── o RM apagou o que escrevemos ──────────────────────────────');
caso(
  'tínhamos escrito, RM está vazio -> reescreve',
  'ESCREVER_NOVO',
  'A',
  { valor: null },
  nosso('A'),
);

console.log('\n── normalização do hash ──────────────────────────────────────');
const ok = (c: boolean, m: string): void => {
  if (!c) falhas += 1;
  console.log(`  ${c ? 'ok  ' : 'FALHA'} ${m}`);
};
ok(hashValor('Frações') === hashValor(' Frações '), 'espaço nas pontas não muda o hash');
ok(hashValor('a  b') === hashValor('a b'), 'espaço interno colapsado');
ok(hashValor('a\r\nb') === hashValor('a\nb'), 'CRLF do RM == LF do Toddle');
ok(hashValor(null) === hashValor(''), 'null e vazio hasheiam igual');
ok(hashValor('A') !== hashValor('P'), 'valores diferentes hasheiam diferente');

console.log('\n── um valor idêntico com espaço não vira escrita perpétua ────');
caso(
  'RM tem "Frações " e queremos "Frações" -> nada a fazer',
  'NADA_A_FAZER',
  'Frações',
  { valor: 'Frações ' },
  nosso('Frações'),
);

console.log('\n── invariantes de podeEscrever / pendencia ───────────────────');
const AUTORIZADOS: Veredito[] = ['ESCREVER_NOVO', 'ATUALIZAR_NOSSO'];
const PENDENTES: Veredito[] = ['CONFLITO_HUMANO', 'EDITADO_POR_FORA', 'REMOCAO_PEDE_HUMANO'];
const amostras: Array<[string | null, EstadoNoRm | null, Proveniencia | null]> = [
  ['A', null, null],
  ['A', { valor: 'A' }, null],
  ['A', { valor: 'P' }, null],
  ['A', { valor: 'P' }, nosso('Z')],
  ['A', { valor: 'P' }, nosso('P')],
  [null, { valor: 'A' }, nosso('A')],
  [null, null, null],
];
const decisoes = amostras.map(([d, r, p]) => decidirEscrita({ chaveNatural: 'k', valor: d }, r, p));
for (const d of decisoes) {
  ok(
    d.podeEscrever === AUTORIZADOS.includes(d.veredito),
    `podeEscrever coerente com ${d.veredito}`,
  );
  ok(d.pendencia === PENDENTES.includes(d.veredito), `pendencia coerente com ${d.veredito}`);
  ok(!(d.podeEscrever && d.pendencia), `${d.veredito} não é escrever E pendência ao mesmo tempo`);
}

const resumo = resumirDecisoes(decisoes);
console.log(`\n  resumo: ${JSON.stringify(resumo)}`);
ok(resumo.total === amostras.length, 'resumo conta o total');
ok(
  resumo.aEscrever + resumo.pendencias <= resumo.total,
  'escritas + pendências nunca excedem o total',
);

console.log(falhas === 0 ? '\n  TODOS OS CASOS PASSARAM\n' : `\n  ${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
