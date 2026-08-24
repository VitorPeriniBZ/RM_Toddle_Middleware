import { logger } from '@rm-toddle/config';
import {
  listarPendencias,
  pgPool,
  resolverPendencia,
  resumoPendencias,
  type EstadoPendencia,
  type VereditoPendente,
} from '@rm-toddle/db';

/**
 * Opera a fila de pendências: o que a integração se RECUSOU a escrever no RM.
 *
 *   npm run pendencias                                    abertas
 *   npm run pendencias -- --todas                          inclui resolvidas
 *   npm run pendencias -- --veredito CONFLITO_HUMANO
 *   npm run pendencias -- --entidade PLANO_AULA
 *   npm run pendencias -- --resolver <id> --quem vitor --nota "corrigi no Toddle"
 *   npm run pendencias -- --ignorar  <id> --quem vitor --nota "e histórico, fica"
 *
 * ─── ESTE COMANDO NÃO CONSERTA NADA ─────────────────────────────────────────
 *
 * `--resolver` é ANOTAÇÃO: registra que uma pessoa olhou e decidiu. Não escreve
 * no RM, não escreve no Toddle. Quem corrige, corrige no sistema certo, à mão.
 *
 * Isso é deliberado. Uma pendência existe porque a máquina não tem informação
 * para decidir — dar a ela um botão de "resolver escrevendo" devolveria à
 * máquina exatamente a decisão que a fila existe para tirar dela.
 */

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const tem = (nome: string): boolean => process.argv.includes(`--${nome}`);

const p = (s = ''): void => console.log(s);

async function decidir(id: string, ignorar: boolean): Promise<void> {
  const quem = arg('quem');
  const nota = arg('nota');
  if (!quem || !nota) {
    p('');
    p('  Faltou --quem e/ou --nota.');
    p('');
    p('  Os dois são obrigatórios, e não é burocracia: uma pendência resolvida sem');
    p('  responsável e sem motivo é indistinguível de uma pendência varrida para');
    p('  debaixo do tapete. Quem decidiu tem de aparecer, e a próxima pessoa que');
    p('  abrir a fila tem de entender a decisão sem perguntar.');
    p('');
    process.exit(1);
  }
  const feito = await resolverPendencia(id, quem, nota, ignorar);
  p('');
  p(
    feito
      ? `  ${ignorar ? 'IGNORADA' : 'RESOLVIDA'}: ${id}\n  por ${quem} — "${nota}"`
      : `  Nada mudou. A pendência ${id} não existe ou já não estava aberta.`,
  );
  p('');
  p('  Lembrete: isto é anotação. Nada foi escrito no RM nem no Toddle.');
  p('');
}

async function main(): Promise<void> {
  const idResolver = arg('resolver');
  const idIgnorar = arg('ignorar');
  if (idResolver) return decidir(idResolver, false);
  if (idIgnorar) return decidir(idIgnorar, true);

  const estado: EstadoPendencia | undefined = tem('todas') ? undefined : 'aberta';
  const pendencias = await listarPendencias({
    estado,
    entidade: arg('entidade') as never,
    veredito: arg('veredito') as VereditoPendente | undefined,
    limite: Number(arg('limite') ?? 50),
  });
  const resumo = await resumoPendencias();

  p('');
  p('══════════════════════════════════════════════════════════════════════');
  p('  Pendências de escrita no RM — o que a integração NÃO escreveu');
  p('══════════════════════════════════════════════════════════════════════');

  if (pendencias.length === 0) {
    p('');
    p(estado === 'aberta' ? '  Nenhuma pendência aberta.' : '  Nenhuma pendência registrada.');
    p('');
    p('  Se a via de volta ainda não escreve, é o esperado: pendência só nasce');
    p('  quando há algo a escrever. Confira `npm run shadow:frequencia`.');
    p('');
    await pgPool.end();
    return;
  }

  for (const x of pendencias) {
    const idade = Math.floor((Date.now() - new Date(x.detectadaEm).getTime()) / 86_400_000);
    const marca = x.estado === 'aberta' ? '●' : '○';
    p('');
    p(`  ${marca} ${x.veredito}   ${x.entidade}${x.campo ? ` / ${x.campo}` : ''}`);
    p(`      id        ${x.id}`);
    p(`      chave     ${x.chaveNatural}`);
    // "(removido)" só faz sentido quando havia um valor e ele sumiu do Toddle —
    // que é o caso de REMOCAO_PEDE_HUMANO. Em OPCAO_SEM_POLITICA a pendência é
    // sobre o CÓDIGO, não sobre uma linha, e nunca houve valor a desejar; imprimir
    // "removido" ali faria parecer que um professor apagou um lançamento.
    if (x.veredito === 'OPCAO_SEM_POLITICA') {
      p('      escopo    o código de chamada, não uma aula — decisão de política');
    } else {
      p(`      Toddle    ${x.valorDesejado ?? '(removido)'}`);
      p(`      RM        ${x.valorNoRm ?? '(ausente)'}`);
    }
    p(`      porque    ${x.porque}`);
    p(
      `      idade     ${idade}d, vista ${x.vezesVista}x` +
        (x.origemId ? `   origem ${x.origemId}` : ''),
    );
    if (x.estado !== 'aberta') p(`      ${x.estado.toUpperCase()}: ${x.resolucao ?? '(sem nota)'}`);
  }

  p('');
  p('──────────────────────────────────────────────────────────────────────');
  p(`  abertas: ${resumo.abertas}`);
  if (resumo.abertas > 0) {
    p(`  por veredito:  ${JSON.stringify(resumo.porVeredito)}`);
    p(`  por entidade:  ${JSON.stringify(resumo.porEntidade)}`);
    if (resumo.maisAntigaDias !== undefined) {
      p(`  mais antiga:   ${resumo.maisAntigaDias} dia(s)`);
    }
    if (resumo.maisVista !== undefined) {
      // Vista muitas vezes = o conflito não se resolve sozinho, e cada passada
      // do cron reconfirma. É o sinal de "isto está travado", não de urgência
      // nova — mas travado por semanas costuma significar que ninguém abriu a fila.
      p(`  mais insistente: vista ${resumo.maisVista}x`);
    }
  }
  p('');

  await pgPool.end();
}

main().catch((err) => {
  logger.error({ err }, 'Falha ao operar a fila de pendências');
  process.exit(1);
});
