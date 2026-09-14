import type { FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '@rm-toddle/config';
import { PAPEIS, identidadeDeCli, identidadeDoGoogle, papeisDoUsuario, type Papel } from '@rm-toddle/db';

/**
 * AUTORIZAÇÃO — "pode o quê", depois que `auth.ts` respondeu "quem é".
 *
 * ─── A LACUNA QUE ISTO FECHA ────────────────────────────────────────────────
 *
 * `auth.ts` sempre disse, no próprio comentário, que pertencer ao Workspace da
 * escola (claim `hd`) é AUTENTICAÇÃO e não autorização, e que quem pode aprovar
 * lançamento no registro acadêmico é decidido pela tabela `membership`. A tabela
 * existe desde a migration 006. Ninguém a consultava.
 *
 * Enquanto a API era só leitura de códigos e ids, a distância entre as duas
 * frases era tolerável. Com uma tela que muda agenda e propõe vínculo, ela é a
 * superfície inteira do sistema: todo mundo da escola autentica, e "todo mundo da
 * escola" não é "quem pode mudar o job que escreve nota no RM". Se aluno tiver
 * conta no mesmo domínio, ele autentica também.
 *
 * ─── NEGAÇÃO POR PADRÃO, INCLUSIVE NA LEITURA ───────────────────────────────
 *
 * Sem linha em `membership`, nenhuma rota protegida responde — nem as de
 * leitura. A tabela nasce vazia, então a primeira concessão é por SCRIPT
 * (`npm run conceder`), fora da tela.
 *
 * Isso trava você fora da própria API no primeiro acesso, e é de propósito. O
 * comando exato do bootstrap sai no LOG do servidor, não na resposta: quem
 * precisa dele é quem tem acesso à máquina, que é — por construção — a única
 * pessoa capaz de executá-lo. Ver a nota em `corpoDeNegacao`.
 *
 * ─── `tenant_admin` SATISFAZ QUALQUER EXIGÊNCIA ─────────────────────────────
 *
 * Os cinco papéis do CHECK não formam hierarquia (um `approver` não é "mais" que
 * um `mapping_manager`), então não há como derivar precedência do schema. A
 * exceção única e explícita é `tenant_admin`: quem administra o tenant pode tudo
 * nele. Sem essa regra, administrar exigiria colecionar os cinco papéis, e a
 * primeira pessoa a fazer isso ia acabar concedendo os cinco a todo mundo.
 */

export interface Autorizacao {
  userIdentityId: string;
  papeis: Papel[];
}

declare module 'fastify' {
  interface FastifyRequest {
    autorizacao?: Autorizacao;
  }
}

/**
 * Cache de `subject -> user_identity.id`.
 *
 * Sem TTL, e pode: a identidade de uma pessoa NUNCA muda (a chave é
 * `(provider, subject)`, e `subject` é imutável por definição do Google). O que
 * muda é o PAPEL dela, e esse cache é outro — 30 s, em `accessRepository`,
 * justamente para revogação ter efeito rápido.
 */
const cacheIdentidade = new Map<string, string>();

/** Identidade do bypass de desenvolvimento, resolvida uma vez por processo. */
let idDeDesenvolvimento: string | undefined;

/** O ator, no formato que `audit_event` espera (migration 006). */
export function atorDaRequisicao(req: FastifyRequest): `user:${string}` | 'system/cli' {
  const id = req.autorizacao?.userIdentityId;
  return id ? `user:${id}` : 'system/cli';
}

/**
 * `preHandler` que exige ao menos um dos papéis.
 *
 * Resolve a identidade no banco (criando na primeira vez) e carrega os papéis em
 * `req.autorizacao`, que é de onde as rotas tiram o ator da auditoria. Criar a
 * identidade NÃO concede nada.
 */
export function exigirPapel(exigidos: Papel[]) {
  return async function verificar(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const identidade = req.identidade;
    if (!identidade) {
      // Só acontece se alguém registrar a rota fora do hook de autenticação.
      await reply.code(500).send({ erro: 'rota protegida sem autenticação configurada' });
      return;
    }

    // Modo de desenvolvimento: `env.ts` já garante que ele só escuta em
    // 127.0.0.1 e recusa subir com NODE_ENV=production, e `auth.ts` loga aviso em
    // TODA requisição. Exigir `membership` aqui obrigaria a semear o banco para
    // rodar a UI local, sem comprar segurança nenhuma — a porta já está fechada
    // pela interface de rede.
    //
    // ─── MAS A IDENTIDADE TEM DE SER REAL ─────────────────────────────────────
    //
    // A primeira versão punha um UUID de zeros aqui, e isso quebrou na primeira
    // escrita: `flow_schedule.atualizado_por` referencia `user_identity`, e o FK
    // recusou — HTTP 500 com "violates foreign key constraint", num caminho que
    // parecia funcionar porque as rotas de LEITURA nunca tocam a coluna.
    //
    // Resolver uma identidade de verdade conserta o FK e, mais importante, deixa
    // a trilha honesta: `provider='cli'`, subject `dev:localhost`. Quem ler a
    // auditoria vê que aquela mudança veio do bypass de desenvolvimento, em vez
    // de um UUID que não existe em lugar nenhum. É a mesma solução que a CLI já
    // usava para aprovar operação sem conta federada.
    if (identidade.semAutenticacao) {
      idDeDesenvolvimento ??= await identidadeDeCli('dev:localhost');
      req.autorizacao = { userIdentityId: idDeDesenvolvimento, papeis: [...PAPEIS] };
      return;
    }

    let userIdentityId = cacheIdentidade.get(identidade.subject);
    if (!userIdentityId) {
      userIdentityId = await identidadeDoGoogle({
        subject: identidade.subject,
        email: identidade.email,
        nome: identidade.nome,
      });
      cacheIdentidade.set(identidade.subject, userIdentityId);
    }

    const papeis = await papeisDoUsuario(userIdentityId);
    req.autorizacao = { userIdentityId, papeis };

    const podeTudo = papeis.includes('tenant_admin');
    if (podeTudo || exigidos.some((p) => papeis.includes(p))) return;

    /*
     * ─── O DIAGNÓSTICO VAI PARA O LOG; PARA A TELA VAI UMA FRASE SÓ ─────────
     *
     * A versão anterior devolvia, NO CORPO DO 403, o comando de bootstrap
     * pronto para copiar — com o `subject` de quem pediu e `--papel
     * tenant_admin` no fim — mais os papéis exigidos, os papéis que a pessoa
     * tem e o nome da tabela de autorização.
     *
     * Quem recebia isso era QUALQUER conta do Workspace da escola, porque é
     * exatamente esse o público do 403: autenticou e não tem papel. Ou seja, a
     * resposta ensinava o modelo de privilégios a quem acabou de ser recusado, e
     * entregava o texto exato para pedir a um administrador sem ele precisar
     * entender o que estava rodando. Se alunos tiverem conta no domínio, a lista
     * inclui alunos.
     *
     * Além do roteiro, os campos eram um ORÁCULO: `papeis.length === 0` contra
     * "tem papel, mas não este" diz ao pedinte se ele já é conhecido do sistema,
     * e `exigidos` diz o nome do papel que protege cada rota. Por isso a
     * mensagem é a MESMA nos dois casos — distinguir já é informação.
     *
     * Nada disso se perde: o log carrega tudo, inclusive o comando, e quem
     * precisa dele é quem tem acesso ao servidor — que é, por construção, a
     * única pessoa capaz de executá-lo.
     */
    logger.warn(
      {
        rota: req.url,
        sub: identidade.subject,
        email: identidade.email,
        papeis,
        exigidos,
        comoLiberar:
          papeis.length === 0
            ? `npm run conceder -- --subject ${identidade.subject}` +
              (identidade.email ? ` --email ${identidade.email}` : '') +
              ' --papel tenant_admin'
            : `npm run conceder -- --subject ${identidade.subject} --papel ${exigidos[0]}`,
      },
      'Autorização NEGADA: identidade autenticada sem papel suficiente neste tenant',
    );

    await reply.code(403).send(corpoDeNegacao());
  };
}

/**
 * O corpo do 403 de autorização. Uma frase, sempre a mesma.
 *
 * Existe como função (e não como literal no meio da rota) para poder ser
 * testada: `packages/db` não alcança `apps/api`, mas o teste ao lado dela
 * alcança, e é ele que garante que nenhum detalhe volte para cá sem alguém
 * perceber.
 *
 * O texto diz o que fazer — pedir a quem administra — sem dizer COMO o sistema
 * decide, porque quem lê isto é, por definição, quem não deveria saber.
 */
export function corpoDeNegacao(): { erro: string } {
  return {
    erro:
      'Sua conta não tem permissão para acessar esta área. Peça acesso a quem administra o ' +
      'middleware na escola.',
  };
}

/** Esvazia o cache de identidade. Para os testes; a identidade real não muda. */
export function limparCacheDeIdentidade(): void {
  cacheIdentidade.clear();
}
