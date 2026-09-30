import { logger } from '@rm-toddle/config';
import { SENTENCAS_DO_TODDLE } from '@rm-toddle/integrations';
import { conferirSentencasUmaVez } from '../agenda/canarioDeSentencas';

/**
 * O CANÁRIO SOB DEMANDA.
 *
 * O worker roda as duas camadas sozinho — corpo de hora em hora, execução uma
 * vez por dia. Este script existe para as três vezes em que esperar não serve:
 *
 *   1. DEPOIS DE UMA CÓPIA DE BASE. É o evento que apaga as Sentenças, e é
 *      conhecido de antemão. Rodar isto na sequência responde em segundos o que
 *      o agendamento responderia em até uma hora.
 *   2. DEPOIS DE RESTAURAR à mão pelo painel, para confirmar que ficou.
 *   3. ANTES DE DEIXAR UM JOB DE ESCRITA RODAR, quando há dúvida. Uma Sentença
 *      rebaixada não dá erro: ela devolve menos coluna, o cruzamento para de
 *      casar, e a proteção contra sobrescrever lançamento de professor se
 *      desliga em silêncio.
 *
 * ─── USO ────────────────────────────────────────────────────────────────────
 *
 *   npm run canario            só o corpo (rápido, 6 leituras)
 *   npm run canario -- --executar   roda as seis Sentenças (lento, ~7 mil
 *                                   linhas por SOAP só na TODDLE.NOTAS)
 *
 * Saída 0 = todas conferem. 1 = há divergência. 2 = alguma não pôde ser
 * verificada (rede) — que NÃO é o mesmo que estar boa. 3 = o RM recusou a
 * CREDENCIAL, o ciclo foi interrompido e as demais NÃO foram tentadas: seis
 * tentativas inválidas seguidas bloqueiam o usuário do RM.
 */

const SAIDA = { ok: 0, divergente: 1, naoVerificada: 2, credencial: 3 } as const;

async function main(): Promise<number> {
  const executar = process.argv.includes('--executar');

  console.log('');
  console.log(`  Camada: ${executar ? 'corpo + execução + volume' : 'corpo (use --executar para tudo)'}`);
  console.log('');

  const passada = await conferirSentencasUmaVez({ executar });

  for (const codigo of passada.avaliadas) {
    const achado = passada.achados.find((a) => a.codigo === codigo);
    if (!achado) {
      console.log(`  ✓ ${codigo.padEnd(20)} confere`);
      continue;
    }
    console.log(`  ✗ ${codigo.padEnd(20)} ${achado.estado} (${achado.camada})`);
    console.log(`      ${achado.detalhe}`);
    if (achado.colunasAusentes.length > 0) {
      console.log(`      colunas ausentes: ${achado.colunasAusentes.join(', ')}`);
    }
  }
  for (const codigo of passada.naoVerificadas) {
    console.log(`  ? ${codigo.padEnd(20)} NÃO VERIFICADA — ver o log acima`);
  }

  console.log('');

  if (passada.credencialRecusada) {
    const naoTentadas =
      SENTENCAS_DO_TODDLE.length - passada.avaliadas.length - passada.naoVerificadas.length;
    console.log('  ✗ O RM RECUSOU A CREDENCIAL. O ciclo foi INTERROMPIDO.');
    console.log('');
    console.log(`    ${naoTentadas} Sentença(s) não foram sequer tentadas, de propósito:`);
    console.log('    elas usam a mesma credencial, e seis tentativas inválidas seguidas');
    console.log('    bloqueiam o usuário do RM — medido em 29/09/2026, causando.');
    console.log('');
    console.log('    O conserto é no CADASTRO do usuário no RM (bloqueio ou senha');
    console.log('    expirada), não no .env: o valor de lá costuma estar certo.');
    console.log('    Ver docs/TODO.md §0.');
    console.log('');
    return SAIDA.credencial;
  }

  if (passada.achados.length > 0) {
    console.log('  Uma Sentença divergente não dá erro em job nenhum: ela devolve');
    console.log('  menos coluna, o cruzamento para de casar, e a proteção contra');
    console.log('  sobrescrever lançamento de professor se desliga em silêncio.');
    console.log('');
    console.log('  Restaurar: pelo painel, aba Sentenças. O botão compara antes de gravar.');
    console.log('');
    return SAIDA.divergente;
  }

  if (passada.naoVerificadas.length > 0) {
    console.log('  Nada divergiu NAS QUE DEU PARA VERIFICAR. As outras continuam');
    console.log('  desconhecidas — "não verifiquei" não é "está bom".');
    console.log('');
    return SAIDA.naoVerificada;
  }

  if (!executar) {
    console.log('  Só o corpo foi conferido. Uma Sentença com o corpo idêntico ainda');
    console.log('  pode devolver menos coluna por permissão — use --executar.');
    console.log('');
  }

  return SAIDA.ok;
}

main()
  .then((codigo) => process.exit(codigo))
  .catch((erro) => {
    logger.error({ erro }, 'Falha ao rodar o canário');
    process.exit(1);
  });
