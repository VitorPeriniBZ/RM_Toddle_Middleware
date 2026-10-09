import { logger } from '@rm-toddle/config';
import { pgPool } from '@rm-toddle/db';
import { SONDAS } from '../continuo/sondas';

/**
 * Roda as sondas do "tempo quase real" UMA vez (ou duas), SEM disparar nada.
 *
 *   npm run continuo:sondar                      # as três
 *   npm run continuo:sondar -- notas             # só uma
 *   npm run continuo:sondar -- notas --desde "2026-09-01 00:00:00"
 *   npm run continuo:sondar -- frequencia --desde 2026-08-24T00:00:00Z
 *
 * Só LÊ: Toddle, RM e o de-para. Não grava memória em `fluxo_continuo`, não
 * enfileira job. Serve para responder "o detector enxerga o que eu acabei de
 * lançar?" sem ligar nada — e para medir quanto cada pergunta custa.
 *
 * Sem `--desde`, a primeira volta é linha de base (nada é novidade) e a segunda
 * mostra o que mudou entre as duas, que normalmente é nada. Com `--desde` (notas
 * e frequência), a primeira volta já trata como novidade tudo o que mudou
 * depois daquela marca — é o jeito de ver o lançamento de um dia antigo passando
 * pelo filtro do de-para.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const iDesde = args.indexOf('--desde');
  const desde = iDesde >= 0 ? args[iDesde + 1] : undefined;
  const nomes = args.filter((a, i) => !a.startsWith('--') && (iDesde < 0 || i !== iDesde + 1));
  const chaves = (nomes.length ? nomes : Object.keys(SONDAS)) as Array<keyof typeof SONDAS>;

  for (const chave of chaves) {
    const sonda = SONDAS[chave];
    if (!sonda) {
      console.log(`detector desconhecido: ${chave}. Aceitos: ${Object.keys(SONDAS).join(', ')}`);
      process.exitCode = 1;
      continue;
    }

    let estado: Record<string, unknown> = {};
    if (desde && chave === 'frequencia') {
      // ISO com Z, o formato do `lastModifiedTimeStamp`.
      estado = { desde, vistos: {} };
    }
    if (desde && chave === 'notas') {
      // Uma marca falsa por currículo: com ela, a sonda não está na "primeira
      // vez" e trata como novidade tudo depois de `desde`.
      const { toddleClient } = await import('@rm-toddle/integrations');
      const ids = (await toddleClient.listCurriculums()).map((c) => String(c.id));
      estado = {
        porCurriculo: Object.fromEntries(ids.map((id) => [id, { desde, vistos: {} }])),
        curriculos: { ids, em: new Date().toISOString() },
      };
    }

    for (const volta of [1, 2]) {
      const t0 = Date.now();
      try {
        const r = await sonda(estado, new Date());
        console.log(
          `[${chave}] volta ${volta}: ${r.resumo}` +
            ` · novidades=${r.novidades} · dispararia=${r.fluxos.join(',') || '—'}` +
            ` · chamadas toddle=${r.chamadas.toddle} rm=${r.chamadas.rm} · ${Date.now() - t0} ms`,
        );
        estado = r.estado;
      } catch (err) {
        console.log(`[${chave}] volta ${volta}: ERRO ${(err as Error).message}`);
        process.exitCode = 1;
        break;
      }
    }
  }
}

main()
  .catch((err) => {
    logger.error({ err }, 'sondarContinuo falhou');
    process.exitCode = 1;
  })
  .finally(() => void pgPool.end().then(() => process.exit()));
