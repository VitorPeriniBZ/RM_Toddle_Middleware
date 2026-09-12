import type { FastifyInstance } from 'fastify';
import { env, logger } from '@rm-toddle/config';
import {
  criarSessao,
  identidadeDoGoogle,
  papeisDoUsuario,
  pgPool,
  registrarEvento,
  revogarPorToken,
  revogarTodasDe,
  sessoesVivasDe,
} from '@rm-toddle/db';
import { opcoesDoCookie, verificarTokenDoGoogle } from '../auth';

/**
 * Sessão do plano de controle.
 *
 * ─── POR QUE O LOGIN É UMA ROTA, E NÃO UM HEADER EM CADA CHAMADA ────────────
 *
 * A tela mandava o ID token do Google em TODA requisição. Isso fazia a sessão
 * durar exatamente o que o Google decide (1 hora) e sumir a cada recarregar de
 * página, porque o token só existia em memória. Pior: não havia como deslogar
 * ninguém — um token copiado valia até vencer.
 *
 * Agora o token do Google é apresentado UMA vez, aqui, e o que circula depois é
 * um cookie `HttpOnly` que este servidor pode revogar a qualquer momento.
 *
 * ─── O TETO MENOR PARA QUEM ADMINISTRA ──────────────────────────────────────
 *
 * `tenant_admin` muda o horário de um job que escreve em registro acadêmico. É o
 * cookie cujo roubo tem o pior resultado, então vive menos. O teto é decidido no
 * NASCIMENTO da sessão — por isso mudar o papel de alguém precisa derrubar as
 * sessões dela, senão quem foi promovido continuaria com o teto antigo.
 */
export async function registrarRotasDeSessao(app: FastifyInstance): Promise<void> {
  /**
   * Troca o ID token do Google por uma sessão.
   *
   * Revoga as sessões anteriores do mesmo subject: se a pessoa está entrando de
   * novo, uma CÓPIA do cookie antigo não deve continuar valendo. O navegador
   * dela perde o cookie antigo de qualquer forma (mesmo nome, sobrescrito) —
   * quem sobreviveria seria justamente uma cópia que ela não controla.
   */
  app.post('/auth/sessao', async (req, reply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return reply.code(401).send({ erro: 'Authorization: Bearer <id_token do Google> ausente' });
    }

    const identidade = await verificarTokenDoGoogle(header.slice(7), reply);
    if (!identidade) return undefined; // `verificarTokenDoGoogle` já respondeu

    // A identidade nasce no login; conceder papel continua sendo outra coisa
    // (tabela `membership`), e é por isso que entrar não dá acesso a nada.
    const userIdentityId = await identidadeDoGoogle(identidade);
    const papeis = await papeisDoUsuario(userIdentityId);
    const absolutoMs = papeis.includes('tenant_admin')
      ? env.SESSAO_ABSOLUTA_ADMIN_MS
      : env.SESSAO_ABSOLUTA_MS;

    await revogarTodasDe(identidade.subject, 'relogin');

    const { cru, sessao } = await criarSessao(
      identidade.subject,
      identidade.email ?? null,
      env.SESSAO_OCIOSA_MS,
      absolutoMs,
      { ip: req.ip, userAgent: req.headers['user-agent'] },
    );

    void reply.setCookie(env.COOKIE_NOME, cru, opcoesDoCookie({ maxAge: Math.floor(absolutoMs / 1000) }));

    // O id da sessão vai para a auditoria: sem ele não há como responder, depois
    // de um incidente, QUAL sessão fez o quê.
    await registrarEvento(pgPool, {
      ator: `user:${identidade.subject}`,
      acao: 'sessao.criada',
      entidade: 'sessao',
      entidadeId: sessao.id,
      depois: { papeis, expiraEm: sessao.expiraEm.toISOString() },
    }).catch((err) => logger.warn({ err }, 'auditoria da criação de sessão falhou'));

    return { expiraEm: sessao.expiraEm, ociosoAte: sessao.ociosoAte, papeis };
  });

  /**
   * Sair.
   *
   * NÃO exige sessão válida: sair da conta não pode falhar. Com cookie já morto
   * a resposta é 200 e o cookie é limpo, não 401.
   *
   * Revoga a sessão no banco, e não só limpa o cookie: limpar o cookie apaga o
   * do navegador de quem está saindo e deixa intacta qualquer cópia que alguém
   * tenha levado.
   */
  app.post('/auth/sair', async (req, reply) => {
    // Lê o cookie direto: esta rota não passa pela autenticação, justamente
    // para que sair com cookie já morto responda 200 e limpe o cookie, em vez
    // de 401.
    const encerrada = await revogarPorToken(req.cookies?.[env.COOKIE_NOME], 'logout');
    if (encerrada) {
      await registrarEvento(pgPool, {
        ator: `user:${encerrada.subject}`,
        acao: 'sessao.encerrada',
        entidade: 'sessao',
        entidadeId: encerrada.id,
      }).catch(() => undefined);
    }
    void reply.clearCookie(env.COOKIE_NOME, opcoesDoCookie());
    return { ok: true };
  });

  /**
   * "Já estou logado?" — a pergunta que a tela precisa fazer ao abrir.
   *
   * Sem esta rota, a tela não tem como saber que existe uma sessão: antes o
   * token vivia na memória do navegador e sumia a cada recarregar, então
   * "recarregou = deslogado" era verdade. Com a sessão no servidor deixou de
   * ser, e a tela continuava mandando todo mundo para o botão do Google com um
   * cookie válido no bolso — que é exatamente o incômodo que a sessão de
   * servidor existe para acabar.
   *
   * Responde 401 quando não há sessão (o hook de autenticação cuida disso), e a
   * tela usa isso para decidir entre a agenda e a tela de login.
   */
  app.get('/auth/eu', async (req, reply) => {
    const subject = req.identidade?.subject;
    if (!subject) return reply.code(401).send({ erro: 'sem sessão' });
    return {
      subject,
      email: req.identidade?.email ?? null,
      expiraEm: req.sessao?.expiraEm ?? null,
      ociosoAte: req.sessao?.ociosoAte ?? null,
    };
  });

  /** Os acessos abertos da própria pessoa. Para ela reconhecer o que não é dela. */
  app.get('/auth/sessoes', async (req, reply) => {
    const subject = req.identidade?.subject;
    if (!subject) return reply.code(401).send({ erro: 'sem sessão' });
    const vivas = await sessoesVivasDe(subject);
    return {
      sessoes: vivas.map((s) => ({ ...s, atual: s.id === req.sessao?.id })),
    };
  });

  /** Derruba as OUTRAS sessões. O botão para quando se desconfia de uma cópia. */
  app.post('/auth/sessoes/encerrar-outras', async (req, reply) => {
    const subject = req.identidade?.subject;
    if (!subject) return reply.code(401).send({ erro: 'sem sessão' });
    const derrubadas = await revogarTodasDe(subject, 'revogar_outras', { excetoId: req.sessao?.id });
    await registrarEvento(pgPool, {
      ator: `user:${subject}`,
      acao: 'sessao.outras.encerradas',
      entidade: 'sessao',
      entidadeId: req.sessao?.id ?? subject,
      depois: { derrubadas },
    }).catch(() => undefined);
    return { derrubadas };
  });
}
