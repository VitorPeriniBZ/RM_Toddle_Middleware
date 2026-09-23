import { env, logger, alertar, tenantConfig, type TenantConfig } from '@rm-toddle/config';
import {
  SENTENCAS_DO_TODDLE,
  conferir,
  lerDoDisco,
  restaurar,
  type CodigoDeSentenca,
} from './sentencasDoRm';

/**
 * RECOLOCAR SOZINHO A SENTENÇA QUE A CÓPIA DE BASE APAGOU.
 *
 * ─── POR QUE ISTO EXISTE ────────────────────────────────────────────────────
 *
 * Sentença mora em `GCONSSQL`, que é DADO: toda cópia de base por cima do
 * ambiente apaga as seis. Aconteceu em 13–15/08/2026, em 16/09/2026 e de novo
 * no domingo 20/09/2026. O conteúdo nunca se perdeu — ele está versionado em
 * `docs/rm-sentencas/*.sql`. O que se perde são os DIAS até alguém perceber,
 * porque o sintoma aparece dentro de um job que roda de madrugada.
 *
 * ─── A MENSAGEM DO RM JUNTA DUAS COISAS QUE NÃO PODEM SER TRATADAS IGUAL ────
 *
 * Ele responde, para os dois casos e também para um código inventado:
 *
 *   "A consulta SQL utilizando a chave 1|S|TODDLE.TURMADISC não existe ou não
 *    pôde ser executada por restrição de filtro por perfil/usuário."
 *
 * "Não existe" e "você não tem permissão" chegam com o MESMO texto. Agir no
 * texto seria escrever no RM por causa de um problema de permissão — e pior, no
 * caso em que a Sentença está lá.
 *
 * Por isso este módulo não acredita na mensagem: ele MEDE qual dos dois casos é,
 * relendo o cadastro pelo `GlbConsSQLData` (outro serviço, outro caminho). É a
 * mesma sonda que `docs/rm-sentencas/README.md` já recomendava para diagnóstico
 * à mão — a diferença é que agora ela roda sozinha.
 *
 * ─── O FREIO: SÓ AUSENTE, NUNCA DIVERGENTE ──────────────────────────────────
 *
 * Restaura apenas quando a Sentença **não existe**. Sentença presente, mesmo
 * divergindo do `.sql`, NÃO é sobrescrita aqui.
 *
 * O motivo é uma armadilha já paga: o RM pode estar À FRENTE do repositório
 * (alguém ajustou a Sentença pela UI e ninguém exportou), e "restaurar" do git
 * seria rebaixar em silêncio um SQL melhor por um pior — sem erro nenhum, e
 * alimentando todos os fluxos com o resultado. Divergência é decisão humana, e
 * continua no botão do painel, onde uma pessoa vê o que vai ser trocado.
 *
 * Ausência não tem essa ambiguidade: não há o que rebaixar.
 *
 * ─── E SE A RESTAURAÇÃO NÃO RESOLVER ────────────────────────────────────────
 *
 * Uma tentativa por código, e o resultado é conferido pelas três camadas do
 * `restaurar` (releitura, execução, volume). Se depois disso a consulta falhar
 * de novo, o job falha — alto, com a mensagem original. Silenciar a segunda
 * falha transformaria "o RM recusa" em "o job responde vazio", que é o modo de
 * falha que este projeto mais paga caro.
 */

/** O que aconteceu, para quem chamou decidir se retenta. */
export type DesfechoDoRestauro =
  | 'restaurada' // estava ausente, foi recolocada e conferida — vale retentar
  | 'existe' // está no RM: o problema é permissão/perfil, não ausência
  | 'desligada' // SENTENCAS_AUTO_RESTAURO=false
  | 'fora-do-catalogo' // código que não é nosso, ou sem .sql no repositório
  | 'falhou'; // tentou recolocar e não passou na conferência

export interface ResultadoDoRestauro {
  desfecho: DesfechoDoRestauro;
  /** Uma linha, já pronta para entrar na mensagem de erro do job. */
  detalhe: string;
}

/**
 * A chave que o RM devolve é `CODCOLIGADA|APLICACAO|CODSENTENCA`. Extrair dela o
 * código, em vez de confiar no que o chamador achava que estava pedindo, é o que
 * garante que a Sentença restaurada é a MESMA que o RM recusou.
 */
const CHAVE = /chave\s+([^|\s]+)\|([^|\s]+)\|([^\s"']+?)\s+não existe ou não pôde ser executada/i;

/**
 * O código da Sentença que o RM disse não existir, ou `null` quando a mensagem é
 * outra coisa.
 *
 * Pura de propósito: é a única parte que depende do texto do RM, e texto de
 * terceiro muda. Isolada aqui, ela é testável sem rede e o resto do módulo não
 * precisa saber como a frase é escrita.
 */
export function sentencaAusenteNaMensagem(mensagem: string): string | null {
  const m = CHAVE.exec(mensagem);
  return m ? m[3].trim() : null;
}

/**
 * Códigos com restauração em curso NESTE processo.
 *
 * O fan-out de alunos são 50 lotes, e seis fluxos podem esbarrar na mesma
 * Sentença ausente no mesmo minuto. Quem chega depois ESPERA o primeiro e
 * aproveita o resultado dele, em vez de mandar 50 SaveRecord do mesmo texto.
 *
 * (A recursão — `restaurar` chama `conferir`, que executa a Sentença pelo mesmo
 * cliente — é impedida antes, e por construção: aquela execução passa
 * `recuperar: false`. Ver `sentencasDoRm`.)
 */
const emCurso = new Map<string, Promise<ResultadoDoRestauro>>();

/**
 * Quem quiser saber que isto aconteceu se registra aqui.
 *
 * O gancho existe por CAMADA: `integrations` conhece só `config`, e não o banco.
 * Puxar `@rm-toddle/db` para cá só para gravar uma linha de auditoria inverteria
 * a dependência — o adaptador do RM passaria a exigir Postgres para ser
 * importado, inclusive nos testes e nos scripts que não têm banco nenhum.
 *
 * Quem registra o observador é o processo do worker, que já tem pool e tenant.
 * Sem observador, o restauro continua funcionando e continua no log e no alerta:
 * a auditoria é um a mais, não a condição para agir.
 */
export type ObservadorDeRestauro = (evento: {
  codigo: string;
  desfecho: DesfechoDoRestauro;
  detalhe: string;
}) => void | Promise<void>;

let observador: ObservadorDeRestauro | null = null;

/** Registra (ou tira, com `null`) quem observa os restauros automáticos. */
export function observarRestauroAutomatico(fn: ObservadorDeRestauro | null): void {
  observador = fn;
}

/** Nunca deixa a falha do observador derrubar o restauro — ele é o acessório. */
async function avisar(codigo: string, r: ResultadoDoRestauro): Promise<void> {
  if (!observador) return;
  try {
    await observador({ codigo, ...r });
  } catch (err) {
    logger.warn({ codigo, err }, 'observador do restauro automático falhou');
  }
}

function ehNossa(codigo: string): codigo is CodigoDeSentenca {
  return (SENTENCAS_DO_TODDLE as readonly string[]).includes(codigo);
}

/**
 * Mede se a Sentença sumiu e, só nesse caso, recoloca.
 *
 * Não lança: devolve o desfecho. Quem chamou é um cliente no meio de um job, e
 * uma exceção daqui esconderia o erro ORIGINAL do RM, que é o que interessa
 * quando a recuperação não é possível.
 */
export async function restaurarSeAusente(
  codigo: string,
  cfg: TenantConfig = tenantConfig,
): Promise<ResultadoDoRestauro> {
  const jaEmCurso = emCurso.get(codigo);
  if (jaEmCurso) return jaEmCurso;

  if (env.SENTENCAS_AUTO_RESTAURO !== 'true') {
    return { desfecho: 'desligada', detalhe: 'restauro automático desligado (SENTENCAS_AUTO_RESTAURO=false)' };
  }
  if (!ehNossa(codigo)) {
    return { desfecho: 'fora-do-catalogo', detalhe: `${codigo} não está no catálogo de Sentenças deste projeto` };
  }
  if (!lerDoDisco(codigo)) {
    return {
      desfecho: 'fora-do-catalogo',
      detalhe: `sem docs/rm-sentencas/${codigo}.sql (ou sem entrada no manifesto) — não há de onde restaurar`,
    };
  }

  const tarefa = executar(codigo, cfg).finally(() => emCurso.delete(codigo));
  emCurso.set(codigo, tarefa);
  return tarefa;
}

async function executar(
  codigo: CodigoDeSentenca,
  cfg: TenantConfig,
): Promise<ResultadoDoRestauro> {
  try {
    /*
     * `executar: false` — a pergunta aqui é só "existe?". Rodar as três camadas
     * agora seria executar a Sentença que ACABOU de falhar, para descobrir de
     * novo que ela falha.
     */
    const antes = await conferir(codigo, cfg, { executar: false });

    if (antes.existeNoRm) {
      const detalhe =
        `${codigo} ESTÁ cadastrada no RM` +
        (antes.releitura.ok ? ' e idêntica ao .sql' : ` porém divergente do .sql (${antes.releitura.detalhe})`) +
        ' — a recusa é de permissão/perfil do usuário do RM, não ausência. ' +
        'Nada foi escrito: sobrescrever cadastro existente é decisão humana, no painel.';
      logger.warn({ codigo, releitura: antes.releitura.detalhe }, 'Sentença presente: não é caso de restauro');
      await alertar({
        assunto: `Sentença ${codigo} recusada pelo RM, e ela ESTÁ lá`,
        contexto: { codigo, causa: 'permissão/perfil do usuário do RM', escrito: 'nada' },
      });
      const r: ResultadoDoRestauro = { desfecho: 'existe', detalhe };
      await avisar(codigo, r);
      return r;
    }

    logger.warn({ codigo }, 'Sentença AUSENTE no RM — recolocando a partir do repositório');
    const depois = await restaurar(codigo, cfg);

    if (depois.confere) {
      const detalhe = `${codigo} estava ausente e foi recolocada a partir do repositório (${depois.volume.detalhe})`;
      logger.info({ codigo, volume: depois.volume.detalhe }, 'Sentença recolocada automaticamente');
      /*
       * Alerta mesmo dando certo, e isto não é ruído: uma Sentença sumir
       * significa que a base foi copiada por cima, e quem opera precisa saber
       * disso — o resto do ambiente (usuário do RM, de-para de COURSE, dado dos
       * jobs) provavelmente também mudou. O sucesso aqui conserta o sintoma,
       * não a causa.
       */
      await alertar({
        assunto: `Sentença ${codigo} sumiu do RM e foi recolocada sozinha`,
        contexto: {
          codigo,
          provavel: 'cópia de base por cima do ambiente',
          confira: 'as outras cinco Sentenças, o usuário do RM e o de-para de COURSE (IDTURMADISC é renumerado)',
        },
      });
      const r: ResultadoDoRestauro = { desfecho: 'restaurada', detalhe };
      await avisar(codigo, r);
      return r;
    }

    const detalhe =
      `${codigo} estava ausente, foi enviada ao RM e NÃO passou na conferência ` +
      `(reprovou em ${depois.reprovouEm ?? 'camada não identificada'}: ` +
      `${depois.reprovouEm === 'execucao' ? depois.execucao.detalhe : depois.releitura.detalhe})`;
    logger.error({ codigo, reprovouEm: depois.reprovouEm }, 'Restauro automático não resolveu');
    await alertar({
      assunto: `Sentença ${codigo} sumiu do RM e o restauro automático NÃO resolveu`,
      contexto: { codigo, reprovouEm: depois.reprovouEm, respostaDoRm: depois.respostaDoRm },
    });
    const r: ResultadoDoRestauro = { desfecho: 'falhou', detalhe };
    await avisar(codigo, r);
    return r;
  } catch (erro) {
    const msg = erro instanceof Error ? erro.message : String(erro);
    logger.error({ codigo, err: erro }, 'Restauro automático falhou');
    const r: ResultadoDoRestauro = {
      desfecho: 'falhou',
      detalhe: `tentativa de restaurar ${codigo} falhou: ${msg.slice(0, 200)}`,
    };
    await avisar(codigo, r);
    return r;
  }
}
