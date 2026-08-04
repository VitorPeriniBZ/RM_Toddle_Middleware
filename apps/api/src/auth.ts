import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env, logger } from '@rm-toddle/config';

/**
 * Autenticação da API.
 *
 * Duas verdades que são fáceis de confundir e caras de errar:
 *
 * 1. A identidade estável do Google é a claim `sub`, NÃO o e-mail. E-mail muda
 *    (casamento, correção de grafia, mudança de domínio) e reaproveitar e-mail
 *    como chave faz o histórico de auditoria apontar para a pessoa errada.
 *
 * 2. Pertencer ao Workspace da escola (claim `hd`) é AUTENTICAÇÃO, não
 *    autorização. Todo mundo da escola autentica; quem pode aprovar lançamento
 *    no registro acadêmico é decidido pela tabela `membership`, não pelo domínio
 *    do e-mail. Este módulo só responde "quem é" — nunca "pode o quê".
 *
 * Validar o domínio pela claim `hd` e não pelo sufixo textual do e-mail é
 * deliberado: e-mail é um campo, `hd` é asserção do provedor.
 */

const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export interface Identidade {
  /** Chave estável — claim `sub`. É o que vai para user_identity.subject. */
  subject: string;
  email?: string;
  nome?: string;
  /** Domínio do Workspace (claim `hd`). */
  hd?: string;
  /** true quando a requisição passou sem token, no modo localhost de dev. */
  semAutenticacao?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    identidade?: Identidade;
  }
}

/** Domínios aceitos, do .env. */
function dominiosAceitos(): string[] {
  return (env.GOOGLE_ALLOWED_HD ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export async function autenticar(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (env.API_AUTH_MODE === 'localhost') {
    // Aviso em TODA requisição, de propósito: modo sem token não deve virar
    // rotina silenciosa. O env.ts já garante que só escuta em localhost e que
    // NODE_ENV != production.
    logger.warn(
      { rota: req.url, ip: req.ip },
      'API_AUTH_MODE=localhost — requisição SEM autenticação (só para desenvolvimento)',
    );
    req.identidade = { subject: 'dev:localhost', semAutenticacao: true };
    return;
  }

  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    await reply.code(401).send({ erro: 'Authorization: Bearer <id_token do Google> ausente' });
    return;
  }

  try {
    const { payload } = await jwtVerify(header.slice(7), JWKS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: env.GOOGLE_CLIENT_ID,
    });

    const hd = typeof payload.hd === 'string' ? payload.hd.toLowerCase() : undefined;
    const aceitos = dominiosAceitos();
    if (!hd || !aceitos.includes(hd)) {
      // Conta Google válida, mas de fora da escola.
      logger.warn({ hd, sub: payload.sub }, 'Token válido porém domínio não autorizado');
      await reply.code(403).send({
        erro: 'Conta fora dos domínios autorizados',
        detalhe: hd ? `domínio "${hd}" não está em GOOGLE_ALLOWED_HD` : 'token sem claim hd (conta pessoal?)',
      });
      return;
    }

    if (!payload.sub) {
      await reply.code(401).send({ erro: 'Token sem claim sub — sem identidade estável' });
      return;
    }

    req.identidade = {
      subject: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      nome: typeof payload.name === 'string' ? payload.name : undefined,
      hd,
    };
  } catch (erro) {
    logger.warn({ erro: erro instanceof Error ? erro.message : erro }, 'Falha ao verificar token');
    await reply.code(401).send({ erro: 'Token inválido, expirado ou de audience diferente' });
  }
}
