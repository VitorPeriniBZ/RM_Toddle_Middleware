import { logger } from '@rm-toddle/config';
import { decidirOperacao, operacoesPendentes, pgPool } from '@rm-toddle/db';

/**
 * Decide sobre escritas que o teto de volume travou.
 *
 *   npm run aprovar                                              lista
 *   npm run aprovar -- --sim  <id> --quem vitor --motivo "..."
 *   npm run aprovar -- --nao  <id> --quem vitor --motivo "..."
 *
 * ─── QUANDO UMA OPERAÇÃO CAI AQUI ───────────────────────────────────────────
 *
 * O teto de volume (`avaliarVolume`) não olha nenhuma linha. Ele compara o
 * TAMANHO do plano com o histórico, porque é a única guarda capaz de pegar
 * defeito estrutural: um `JOIN` errado no de-para gera milhares de escritas
 * individualmente corretas, e o erro só aparece no agregado.
 *
 * Três situações trazem uma operação para cá:
 *
 *   - é a PRIMEIRA escrita da vida (ninguém nunca viu o writer tocar o RM)
 *   - o plano está muito acima do histórico
 *   - o plano toca uma fatia grande do escopo da janela
 *
 * ─── O QUE OLHAR ANTES DE DIZER SIM ─────────────────────────────────────────
 *
 * O número. Se o plano quer escrever 3.000 linhas onde o normal são 200, a
 * pergunta não é "autorizo?" e sim "o que aconteceu?". Costuma ser uma de três
 * coisas, e nenhuma se resolve aprovando:
 *
 *   1. a janela de datas está maior do que se pensava;
 *   2. o de-para mudou e o cruzamento passou a casar o que não casava;
 *   3. o período letivo divergiu e TUDO parece faltando no RM.
 *
 * Aprovar sem responder isso é assinar embaixo de um número que ninguém entendeu.
 * `--motivo` existe para registrar a resposta, não para preencher formulário.
 */

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const p = (s = ''): void => console.log(s);

async function decidir(id: string, sim: boolean): Promise<void> {
  const quem = arg('quem');
  const motivo = arg('motivo');
  if (!quem || !motivo) {
    p('');
    p('  Faltou --quem e/ou --motivo, e os dois são obrigatórios.');
    p('');
    p('  Não é formulário: uma escrita fora do normal autorizada sem nome e sem');
    p('  explicação é indistinguível de uma escrita que ninguém revisou. O motivo');
    p('  é onde fica registrado O QUE explicava o número.');
    p('');
    process.exit(1);
  }
  const r = await decidirOperacao(id, quem, sim ? 'approved' : 'rejected', motivo);
  p('');
  if (!r.ok) {
    p(`  Não foi possível decidir: ${r.erro}`);
    p('');
    process.exit(1);
  }
  p(`  ${sim ? 'APROVADA' : 'RECUSADA'}: ${id}`);
  p(`  por ${quem} — "${motivo}"`);
  p('');
  p(
    sim
      ? '  O writer executará no próximo disparo. A aprovação vale para ESTE run;\n' +
        '  o seguinte é avaliado de novo pelo teto.'
      : '  Nada será escrito. O run recusado não volta sozinho — investigue a causa.',
  );
  p('');
}

async function main(): Promise<void> {
  const sim = arg('sim');
  const nao = arg('nao');
  if (sim) return decidir(sim, true);
  if (nao) return decidir(nao, false);

  const fila = await operacoesPendentes();
  p('');
  p('══════════════════════════════════════════════════════════════════════');
  p('  Escritas no RM esperando decisão humana');
  p('══════════════════════════════════════════════════════════════════════');

  if (fila.length === 0) {
    p('');
    p('  Nada esperando.');
    p('');
    p('  Se a via de volta ainda não escreve, é o esperado: o teto só é avaliado');
    p('  quando há plano de escrita. Confira `npm run shadow:frequencia`.');
    p('');
    await pgPool.end();
    return;
  }

  for (const op of fila) {
    const pay = op.payload as Record<string, unknown>;
    const motivos = Array.isArray(pay.motivos) ? (pay.motivos as string[]) : [];
    p('');
    p(`  ● ${op.tipo}`);
    p(`      id          ${op.id}`);
    p(`      run         ${op.chave}`);
    p(`      desde       ${op.criadoEm.slice(0, 16).replace('T', ' ')}`);
    if (pay.aEscrever !== undefined) {
      p(
        `      quer escrever ${pay.aEscrever} linha(s)` +
          (pay.emEscopo !== undefined ? ` de ${pay.emEscopo} em escopo` : '') +
          (pay.historico !== undefined && pay.historico !== null
            ? `   (histórico: ${pay.historico})`
            : '   (sem histórico)'),
      );
    }
    if (pay.pctSobreHistorico !== undefined && pay.pctSobreHistorico !== null) {
      p(`      desvio      ${pay.pctSobreHistorico}% sobre o histórico`);
    }
    if (pay.pctDoEscopo !== undefined && pay.pctDoEscopo !== null) {
      p(`      escopo      ${pay.pctDoEscopo}% da janela`);
    }
    for (const m of motivos) p(`      motivo      ${m}`);
    if (op.criadoPor) {
      p(`      proponente  ${op.criadoPor}  ← precisa de OUTRA pessoa para aprovar`);
    }
  }

  p('');
  p('──────────────────────────────────────────────────────────────────────');
  p(`  ${fila.length} esperando.`);
  p('');
  p('  Antes de aprovar, responda: por que o número é este? Janela maior,');
  p('  de-para alterado, ou período letivo divergente? Aprovar sem responder é');
  p('  assinar embaixo de um número que ninguém entendeu.');
  p('');
  p('  npm run aprovar -- --sim <id> --quem <voce> --motivo "..."');
  p('');

  await pgPool.end();
}

main().catch((err) => {
  logger.error({ err }, 'Falha ao operar a fila de aprovação');
  process.exit(1);
});
