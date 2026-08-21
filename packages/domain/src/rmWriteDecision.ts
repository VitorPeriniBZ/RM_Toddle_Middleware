import { createHash } from 'node:crypto';

/**
 * A decisão de escrever no RM, ou não.
 *
 * ─── POR QUE ISTO É UM MÓDULO SEPARADO E PURO ───────────────────────────────
 *
 * É a regra que impede a integração de apagar trabalho humano, e o RM não é um
 * destino vazio. Medido: 21.300 ausências, ~10.000 notas e 12.166 conteúdos de
 * aula lançados à mão. O `SaveRecord` é upsert por chave e **não diz se inseriu
 * ou atualizou** — então sem esta decisão toda escrita é aposta.
 *
 * Sem I/O aqui de propósito: recebe os três estados já lidos e devolve o
 * veredito. Isso a torna testável sem RM, sem banco e sem rede — e é o tipo de
 * regra em que um erro só aparece como dado de professor destruído, semanas
 * depois, sem log.
 *
 * ─── AS TRÊS ENTRADAS ───────────────────────────────────────────────────────
 *
 *   1. o que QUEREMOS escrever      (vem do Toddle, já projetado)
 *   2. o que o RM TEM hoje          (vem de Sentença — a única via com autoria)
 *   3. o que NÓS escrevemos antes   (vem de rm_write_provenance)
 *
 * O ponto 2 tem de vir de Sentença, não de DataServer: o schema do
 * `EduFrequenciaDiariaWSData` e do `EduPlanoAulaData` **não expõe**
 * `RECCREATEDBY`/`RECMODIFIEDBY`. Sem autoria, "vazio ou nosso" é indistinguível
 * de "preenchido por humano".
 */

export type Veredito =
  /** Não existe no RM e não temos proveniência. Caminho normal do primeiro sync. */
  | 'ESCREVER_NOVO'
  /** Existe, a proveniência é nossa, e o valor mudou. Atualizar é seguro. */
  | 'ATUALIZAR_NOSSO'
  /** Existe e já é exatamente o que queríamos. Não gastar chamada. */
  | 'NADA_A_FAZER'
  /**
   * Existe no RM e NÃO é nosso. Um humano escreveu.
   *
   * NUNCA sobrescrever. Vira pendência de revisão — alguém decide caso a caso.
   */
  | 'CONFLITO_HUMANO'
  /**
   * Existe, a proveniência é nossa, MAS o valor no RM não é o que deixamos.
   *
   * Alguém editou depois de nós, dentro do RM. Tecnicamente poderíamos
   * sobrescrever "porque a linha é nossa" — e é exatamente isso que não se faz:
   * a edição é mais recente e é humana. Também vira pendência.
   */
  | 'EDITADO_POR_FORA'
  /**
   * O Toddle não tem mais o registro (professor removeu a falta).
   *
   * Remoção de falta tem consequência legal e de comunicação com a família, e
   * `DELETE` no diário não se faz por inferência. Vira tarefa humana.
   */
  | 'REMOCAO_PEDE_HUMANO';

export interface Decisao {
  veredito: Veredito;
  /** Frase pronta para log e para a fila de pendências. */
  porque: string;
  /** `true` só nos dois vereditos que autorizam chamar o SaveRecord. */
  podeEscrever: boolean;
  /** `true` quando a decisão exige olho humano. */
  pendencia: boolean;
}

/** O que a integração quer deixar no RM. */
export interface Desejado {
  /** Chave natural no RM. Mesma que dá idempotência ao job. */
  chaveNatural: string;
  /**
   * Valor a escrever, já normalizado. `null` = a origem não tem mais o registro
   * (professor removeu no Toddle).
   */
  valor: string | null;
}

/** O que o RM tem hoje, lido por Sentença. `null` = não existe a linha/campo. */
export interface EstadoNoRm {
  valor: string | null;
  /** `RECCREATEDBY` — o login que criou. */
  criadoPor?: string;
  /** `RECMODIFIEDBY` — o login que alterou por último. */
  alteradoPor?: string;
}

/** O que registramos ter escrito. `null` = nunca escrevemos esta chave. */
export interface Proveniencia {
  payloadHash: string;
  escritoEm: string;
}

/**
 * Hash do valor escrito.
 *
 * `sha256` truncado em 32 hex: o suficiente para detectar mudança, curto o
 * bastante para caber confortavelmente numa coluna indexada. Não é segurança —
 * é comparação.
 *
 * Normaliza antes de hashear, porque o RM devolve espaço em branco e quebra de
 * linha de formas que o Toddle não usa, e um hash sensível a isso reportaria
 * "mudou" a cada leitura, transformando `NADA_A_FAZER` em escrita perpétua.
 */
export function hashValor(valor: string | null): string {
  const normalizado = (valor ?? '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalizado).digest('hex').slice(0, 32);
}

/** Vazio para efeito da regra: `null`, string vazia ou só espaço. */
const vazio = (v: string | null | undefined): boolean => !v || v.trim() === '';

/**
 * Decide. A ordem de avaliação é a ordem de gravidade, e não é permutável.
 *
 * @param usuarioIntegracao login da integração no RM (`RM_WS_USER`). Serve de
 *   segunda evidência de autoria quando a proveniência local foi perdida — por
 *   exemplo depois de uma restauração do nosso Postgres. Sem ele, um banco
 *   recém-restaurado veria todo o próprio trabalho anterior como conflito
 *   humano e pararia o sync inteiro.
 */
export function decidirEscrita(
  desejado: Desejado,
  noRm: EstadoNoRm | null,
  proveniencia: Proveniencia | null,
  usuarioIntegracao?: string,
): Decisao {
  const valorRm = noRm?.valor ?? null;
  const existeNoRm = !vazio(valorRm);

  // 1. A origem removeu. Nunca inferimos DELETE.
  if (desejado.valor === null) {
    if (!existeNoRm) {
      return {
        veredito: 'NADA_A_FAZER',
        porque: 'removido no Toddle e já ausente no RM',
        podeEscrever: false,
        pendencia: false,
      };
    }
    return {
      veredito: 'REMOCAO_PEDE_HUMANO',
      porque:
        'o registro saiu do Toddle mas existe no RM. Remoção de falta/conteúdo tem ' +
        'efeito legal e de comunicação com a família — decisão humana, caso a caso',
      podeEscrever: false,
      pendencia: true,
    };
  }

  const hashDesejado = hashValor(desejado.valor);

  // 2. Não existe no RM: caminho normal.
  if (!existeNoRm) {
    return {
      veredito: 'ESCREVER_NOVO',
      porque: proveniencia
        ? 'ausente no RM, embora já tenhamos escrito antes — alguém apagou lá, e ' +
          'reescrever restaura o que o professor lançou no Toddle'
        : 'ausente no RM e nunca escrito por nós',
      podeEscrever: true,
      pendencia: false,
    };
  }

  // 3. Existe e é idêntico. Vale antes de olhar autoria: se o RM já tem o que
  //    queremos, a autoria é irrelevante e não há chamada a fazer.
  if (hashValor(valorRm) === hashDesejado) {
    return {
      veredito: 'NADA_A_FAZER',
      porque: 'o RM já tem exatamente este valor',
      podeEscrever: false,
      pendencia: false,
    };
  }

  // 4. Existe, é diferente, e não temos proveniência.
  if (!proveniencia) {
    // Segunda evidência: o próprio RM diz quem escreveu. Cobre o caso de o nosso
    // Postgres ter sido restaurado e perdido a proveniência.
    const autor = noRm?.alteradoPor ?? noRm?.criadoPor;
    if (usuarioIntegracao && autor && autor.trim() === usuarioIntegracao.trim()) {
      return {
        veredito: 'ATUALIZAR_NOSSO',
        porque:
          `sem proveniência local, mas o RM registra "${autor}" como autor — é a ` +
          'conta da integração, então a linha é nossa',
        podeEscrever: true,
        pendencia: false,
      };
    }
    return {
      veredito: 'CONFLITO_HUMANO',
      porque:
        `o RM tem valor diferente e a autoria é ${autor ? `"${autor}"` : 'desconhecida'}, ` +
        'não a integração. Sobrescrever apagaria lançamento humano',
      podeEscrever: false,
      pendencia: true,
    };
  }

  // 5. Temos proveniência, mas o RM não tem o que deixamos: editaram depois.
  if (proveniencia.payloadHash !== hashValor(valorRm)) {
    return {
      veredito: 'EDITADO_POR_FORA',
      porque:
        `escrevemos em ${proveniencia.escritoEm}, mas o RM tem outro valor agora — ` +
        'alguém editou lá depois de nós. A edição é mais recente e é humana',
      podeEscrever: false,
      pendencia: true,
    };
  }

  // 6. É nosso, está intacto, e o Toddle mudou. Único UPDATE autorizado.
  return {
    veredito: 'ATUALIZAR_NOSSO',
    porque: 'a linha é nossa e está intacta desde a última escrita; a origem mudou',
    podeEscrever: true,
    pendencia: false,
  };
}

export interface ResumoDecisoes {
  total: number;
  porVeredito: Record<string, number>;
  aEscrever: number;
  pendencias: number;
}

/** Agrega para o relatório do shadow e para o `resultado` do run. */
export function resumirDecisoes(decisoes: Decisao[]): ResumoDecisoes {
  const porVeredito: Record<string, number> = {};
  for (const d of decisoes) porVeredito[d.veredito] = (porVeredito[d.veredito] ?? 0) + 1;
  return {
    total: decisoes.length,
    porVeredito,
    aEscrever: decisoes.filter((d) => d.podeEscrever).length,
    pendencias: decisoes.filter((d) => d.pendencia).length,
  };
}
