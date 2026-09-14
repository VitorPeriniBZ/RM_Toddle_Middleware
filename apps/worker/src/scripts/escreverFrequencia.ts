import { logger } from '@rm-toddle/config';
import { pgPool } from '@rm-toddle/db';
import {
  sincronizarFrequencia,
  type RelatorioDeFrequencia,
} from '../services/sincronizarFrequencia';

/**
 * ESCREVE a frequência do Toddle no TOTVS RM — o CLI.
 *
 *   npm run escrever:frequencia -- --de 2026-08-24 --ate 2026-08-24
 *   npm run escrever:frequencia -- --de 2026-08-24 --ate 2026-08-24 --turma 1266
 *   npm run escrever:frequencia -- ... --executar
 *
 * ─── SEM `--executar`, NADA É ENVIADO ───────────────────────────────────────
 *
 * O default é ensaio. Não por timidez: esta é uma das duas escritas que alteram
 * a base acadêmica de uma escola, e o `SaveRecord` é upsert que responde HTTP
 * 200 mesmo recusando. Um default que escreve transformaria erro de digitação em
 * incidente.
 *
 * ─── A REGRA NÃO MORA MAIS AQUI ─────────────────────────────────────────────
 *
 * Os quatro guardas, a decisão por linha, a fila de pendências e a conferência
 * por releitura vivem em `services/sincronizarFrequencia.ts`, que é o MESMO
 * código que o job `attendance.sync` executa. Este arquivo só traduz argumentos
 * e imprime — e é isso que impede o CLI e o automático de divergirem, sendo que
 * o lado que divergiria em silêncio é o automático, que ninguém lê.
 */

interface Args {
  de: string;
  ate: string;
  turma?: string;
  executar: boolean;
  quem?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const pega = (nome: string): string | undefined => {
    const i = argv.indexOf(`--${nome}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const de = pega('de');
  const ate = pega('ate');
  const dataOk = (v: string | undefined): boolean => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v));

  if (!dataOk(de) || !dataOk(ate)) {
    throw new Error(
      'Faltou a janela de datas. Uso: --de YYYY-MM-DD --ate YYYY-MM-DD ' +
        '[--turma IDTURMADISC] [--executar] [--quem SEU_NOME]',
    );
  }
  if ((de as string) > (ate as string)) {
    throw new Error(`Janela invertida: --de ${de} é depois de --ate ${ate}.`);
  }
  return {
    de: de as string,
    ate: ate as string,
    turma: pega('turma'),
    executar: argv.includes('--executar'),
    quem: pega('quem'),
  };
}

const p = (s = ''): void => {
  // eslint-disable-next-line no-console
  console.log(s);
};

/** O plano: o que seria escrito, e por que o resto não seria. */
function imprimirPlano(r: RelatorioDeFrequencia, executar: boolean): void {
  p('');
  p('══════════════════════════════════════════════════════════════════');
  p(`  FREQUÊNCIA Toddle -> RM   ${executar ? '*** ESCRITA ***' : '(ensaio)'}`);
  p('══════════════════════════════════════════════════════════════════');
  p(`  janela         ${r.janela.de} → ${r.janela.ate}`);
  p(`  campus         CODFILIAL=${r.codFilial}   coligada=${r.coligada}`);
  p(`  escopo         ${r.turmasEmEscopo} turma-disciplina, ${r.alunosMapeados} alunos`);
  p(`  configVersion  ${r.configVersion}`);
  p(`  run            ${r.chaveRun}`);
  p(`  aprovação      ${r.chaveDeAprovacao}`);
  p('');
  p('── plano ─────────────────────────────────────────────────────────');
  p(`  lidos do Toddle                 ${r.lidosDoToddle}`);
  p(`  projetáveis                     ${r.projetaveis}`);
  p(`  recusados na projeção           ${r.recusadosNaProjecao}`);
  for (const [motivo, n] of Object.entries(r.porMotivo)) p(`      ${motivo.padEnd(28)} ${n}`);
  p('');
  for (const [veredito, n] of Object.entries(r.porVeredito)) p(`      ${veredito.padEnd(28)} ${n}`);
  p(`  A ESCREVER                      ${r.aEscrever}`);
  p(`  pendências (precisam de humano) ${r.pendenciasDeDecisao}`);
  p('');
  p(`  datasets escrevíveis            ${r.escreviveis.length}`);
  for (const l of r.escreviveis) {
    p(`      IDTURMADISC ${l.idTurmaDisc}  etapa ${l.codEtapa}  ${l.linhas} linha(s)  AULASDADAS=${l.aulasDadas}`);
  }
  if (r.semAulasDadas.length) {
    p('');
    p(`  RECUSADOS por AULASDADAS ausente no RM   ${r.semAulasDadas.length}`);
    for (const l of r.semAulasDadas) {
      p(`      IDTURMADISC ${l.idTurmaDisc}  etapa ${l.codEtapa}  ${l.linhas} linha(s)`);
    }
    p('      A etapa não tem número de aulas dadas no RM. Não há o que ecoar, e');
    p('      calcular mudaria o denominador dos 75%. Preencha no RM primeiro.');
  }
  p('');
  p(`  teto de volume                  ${r.volume.veredito}`);
  for (const m of r.volume.motivos) p(`      ${m}`);
  p('');
  p(`  fila de pendências (aberta)     ${r.filaDePendencias.abertas}   (${r.filaDePendencias.nestaPassada} nesta passada)`);
}

/** O desfecho quando não houve escrita. Cada motivo é um caminho legítimo. */
function imprimirNaoEscreveu(r: RelatorioDeFrequencia): void {
  p('');
  switch (r.naoEscreveu) {
    case 'ensaio':
      p('  ENSAIO. Nada foi enviado ao RM. Use --executar para escrever.');
      break;
    case 'nada-a-escrever':
      p('  Nada a escrever. Encerrando sem tocar o RM.');
      break;
    case 'recusado-pelo-teto':
      p('  RECUSADO pelo teto de volume. Nada foi enviado.');
      p('  Isto não é para ser aprovado — é para ser investigado. Confira o de-para');
      p('  e a janela antes de rodar de novo.');
      process.exitCode = 1;
      break;
    case 'precisa-aprovacao':
      p('  PARADO no gate de aprovação. Nada foi enviado ao RM.');
      p('  A proposta está registrada. Para liberar:');
      p('');
      p('      npm run aprovar                      # lista o que espera decisão');
      p('      npm run aprovar -- --sim <ID> --quem "Seu Nome" --motivo "..."');
      p('');
      p(`  Aprove com: --chave ${r.chaveDeAprovacao}`);
      p('  Depois rode este comando de novo: ele reencontra a aprovação e executa.');
      break;
  }
  p('');
}

function imprimirEnvio(r: RelatorioDeFrequencia): void {
  const e = r.envio;
  if (!e) return;
  p('');
  p('── conferindo por leitura ────────────────────────────────────────');
  p(`  faltas na janela        ${e.faltasAntes} → ${e.faltasDepois}`);
  p(`  linhas escritas         ${e.escritas}   recusadas ${e.recusadas}   sem resposta ${e.desconhecidas}`);
  p(`  envios ao RM            ${e.chamadas}`);
  p(`  ausências CONFERIDAS    ${e.ausenciasConfirmadas}/${e.ausenciasEsperadas}   (releitura achou a linha no RM)`);
  p(`  presenças enviadas      ${e.presencasEnviadas}   (não verificáveis: 'P' não cria linha na SFREQUENCIA)`);

  if (e.recusadas) {
    p('');
    p(`  ${e.recusadas} linha(s) o RM recusou individualmente — viraram pendência:`);
    for (const x of e.amostraDeRecusas) {
      p(`      RA ${x.ra}  IDTURMADISC ${x.idTurmaDisc}  ${x.data}`);
    }
    p('      `npm run pendencias` mostra a resposta do RM em cada uma.');
  }

  p('');
  if (e.ok && e.recusadas === 0) {
    p('  OK — a frequência lançada no Toddle está no RM, e a proveniência registrou');
    p('  cada linha. `npm run runs` mostra o run; a lista de reversão sai dele.');
  } else if (e.ok) {
    p('  PARCIAL — o que o RM aceitou está escrito e com proveniência. O que ele');
    p('  recusou está na fila de pendências, com a resposta dele. Nada foi perdido');
    p('  em silêncio, e nada será repetido automaticamente.');
  } else {
    p('  ATENÇÃO — o run não fechou limpo. Há linha sem resposta ou ausência que a');
    p('  releitura não encontrou. Nada será repetido automaticamente.');
  }
  p('');
}

async function main(): Promise<void> {
  const args = parseArgs();
  const r = await sincronizarFrequencia(args);

  imprimirPlano(r, args.executar);
  if (r.escrita) imprimirEnvio(r);
  else imprimirNaoEscreveu(r);

  await pgPool.end();
}

main().catch(async (err) => {
  logger.error({ err }, 'Falha na escrita de frequência');
  await pgPool.end().catch(() => undefined);
  process.exit(1);
});
