import { PAPEIS, concederPapel, listarAcessos, pgPool, type Papel } from '@rm-toddle/db';
import { tenantConfig } from '@rm-toddle/config';

/**
 * Concede acesso à API/tela. É o BOOTSTRAP da autorização.
 *
 *   npm run conceder                                          lista quem tem acesso
 *   npm run conceder -- --subject <sub> --papel tenant_admin --email voce@escola...
 *
 * ─── POR QUE ISTO É UM SCRIPT, E NÃO UMA TELA ───────────────────────────────
 *
 * `membership` nasce vazia e a autorização nega por padrão, então na primeira
 * subida NINGUÉM tem acesso — inclusive quem deu o deploy. A saída óbvia seria
 * uma tela que concede o primeiro papel; ela não existe de propósito, porque uma
 * porta que pode abrir a si mesma não é uma porta trancada.
 *
 * ─── COMO DESCOBRIR O SEU `subject` ─────────────────────────────────────────
 *
 * Não é o e-mail. É a claim `sub` do Google — a identidade estável, porque e-mail
 * muda (casamento, correção de grafia, mudança de domínio) e reaproveitar e-mail
 * como chave faz a auditoria apontar para a pessoa errada.
 *
 * Você não precisa saber de cor: entre na tela e receba o 403. A resposta traz o
 * SEU subject e este comando pronto, com o valor preenchido. É a sua identidade
 * devolvida para você, então não revela nada de ninguém.
 *
 * ─── QUAL PAPEL ─────────────────────────────────────────────────────────────
 *
 *   viewer                lê o painel, a agenda e o de-para
 *   integration_operator  acompanha execução
 *   mapping_manager       PROPÕE mudança de vínculo (não efetiva)
 *   approver              decide sobre operação pendente
 *   tenant_admin          tudo, incluindo mudar horário e ligar/desligar fluxo
 */

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const p = (s = ''): void => console.log(s);

async function listar(): Promise<void> {
  const acessos = await listarAcessos();
  p('');
  p(`  ACESSO AO TENANT "${tenantConfig.slug}"`);
  p('');
  if (acessos.length === 0) {
    p('  Ninguém. A tabela membership está vazia, então a API nega TUDO — o que é o');
    p('  comportamento correto e também o motivo de este script existir.');
    p('');
    p('  Entre na tela, receba o 403, e ele devolve o comando pronto com o seu subject.');
    p('');
    return;
  }
  for (const a of acessos) {
    p(`  ${a.email ?? a.nome ?? a.subject}`);
    p(`    provider: ${a.provider}   subject: ${a.subject}`);
    p(`    papéis:   ${a.papeis.join(', ')}`);
    p('');
  }
}

async function main(): Promise<void> {
  const subject = arg('subject');
  const papel = arg('papel') as Papel | undefined;

  if (!subject && !papel) {
    await listar();
    return;
  }

  if (!subject || !papel) {
    p('');
    p('  Faltou --subject e/ou --papel.');
    p('');
    p(`  Papéis aceitos: ${PAPEIS.join(', ')}`);
    p('');
    p('  O subject é a claim `sub` do Google, NÃO o e-mail. Entre na tela e leia o');
    p('  403: ele devolve o seu subject e o comando pronto.');
    p('');
    process.exit(1);
  }

  if (!PAPEIS.includes(papel)) {
    p('');
    p(`  Papel "${papel}" não existe. Aceitos: ${PAPEIS.join(', ')}`);
    p('');
    p('  A lista não é opinião deste script: é o CHECK de membership na migration 006.');
    p('');
    process.exit(1);
  }

  const r = await concederPapel(
    { subject, email: arg('email'), nome: arg('nome'), provider: (arg('provider') as 'google' | 'cli') ?? 'google' },
    papel,
  );

  p('');
  p(r.jaTinha ? `  Já tinha: ${papel}` : `  CONCEDIDO: ${papel}`);
  p(`  tenant:   ${tenantConfig.slug}`);
  p(`  subject:  ${subject}`);
  p(`  identidade: ${r.userIdentityId}`);
  p('');
  p('  O cache de papéis da API expira em 30s — recarregue a tela depois disso.');
  p('');
}

main()
  .then(() => pgPool.end())
  .catch(async (err) => {
    p('');
    p(`  Falhou: ${err instanceof Error ? err.message : String(err)}`);
    p('');
    await pgPool.end();
    process.exit(1);
  });
