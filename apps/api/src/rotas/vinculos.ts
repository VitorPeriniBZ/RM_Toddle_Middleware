import type { FastifyPluginAsync } from 'fastify';
import { tenantConfig } from '@rm-toddle/config';
import {
  ENTITY_TYPES,
  FORMAS,
  decidirProposta,
  idMappingRepository,
  propor,
  propostasPendentes,
  validarProposta,
  type EntityType,
  type PropostaDeVinculo,
} from '@rm-toddle/db';
import { toddleClient } from '@rm-toddle/integrations';
import { atorDaRequisicao, exigirPapel } from '../autorizacao';

/**
 * O DE-PARA na tela: LER sim, EDITAR não.
 *
 * ─── A DIVISÃO ──────────────────────────────────────────────────────────────
 *
 * Busca, duplicata e órfão são LEITURA, e substituem a maior parte do que eu
 * fazia no psql. Mudança de vínculo é PROPOSTA: cria uma `operation` com payload
 * congelado e `source_snapshot`, e alguém decide num segundo passo, com o diff à
 * vista e o snapshot revalidado antes de gravar.
 *
 * Nenhuma rota aqui escreve em `id_mapping` diretamente. A regra não é de estilo:
 * um vínculo errado é nota ou falta gravada na turma, no aluno ou na etapa
 * errada de um registro acadêmico que já tem ~10 mil notas e 14,6 mil faltas
 * lançadas à mão. E o `configVersion` não protege contra isso — ele cobre escopo
 * e destino, e mapeamento é dado, não configuração.
 *
 * ─── SEM PII ────────────────────────────────────────────────────────────────
 *
 * Como as rotas de leitura que já existiam: códigos e ids, nunca nomes. A busca é
 * por CÓDIGO justamente por isso — não há caminho aqui para "listar alunos
 * chamados João".
 */

/**
 * Tipos cujo órfão dá para verificar contra o Toddle, e o que os outros têm de
 * diferente.
 *
 * ─── POR QUE ALUNO, PROFESSOR E RESPONSÁVEL FICAM DE FORA ───────────────────
 *
 * Porque para eles "a API não devolveu" NÃO significa "não existe". O Toddle não
 * devolve registro ARQUIVADO — nem filtrando por `sourceId` —, então um aluno
 * arquivado apareceria como órfão, e agir sobre esse falso positivo é exatamente
 * o que apagou 186 linhas em 31/07/2026 e destruiu o único caminho de volta para
 * aqueles registros.
 *
 * Uma verificação que produz falso positivo justamente no caso perigoso é pior
 * que nenhuma: ela convida à ação errada com aparência de evidência.
 */
const ORFAOS_VERIFICAVEIS: Partial<Record<EntityType, string>> = {
  YEAR_GROUP: 'GET /year-groups por currículo',
  COURSE: 'GET /classes',
};

const MOTIVO_NAO_VERIFICAVEL =
  'o Toddle não devolve registro arquivado (nem por sourceId), então "não veio na resposta" não ' +
  'significa "não existe". Tratar essa ausência como órfão foi o que apagou 186 linhas em ' +
  '31/07/2026 e destruiu o único caminho de volta para elas.';

/*
 * Registrado como PLUGIN, e não como função que recebe a instância: a instância
 * é criada com `loggerInstance`, o que especializa o genérico do logger e faz o
 * `FastifyInstance` default deixar de ser atribuível. O tipo de plugin não tem
 * esse acoplamento — e o hook de autenticação do pai continua valendo aqui,
 * porque encapsulamento no Fastify herda hooks para baixo.
 */
export const registrarRotasDeVinculos: FastifyPluginAsync = async (app) => {
  /** Busca por trecho de código do RM OU de id do Toddle, em todos os tipos. */
  app.get<{ Querystring: { q?: string; limite?: string } }>(
    '/mappings/busca',
    { preHandler: exigirPapel(['viewer']) },
    async (req, reply) => {
      const q = req.query.q?.trim();
      if (!q || q.length < 2) {
        return reply.code(400).send({ erro: 'q é obrigatório e precisa ter ao menos 2 caracteres' });
      }
      const achados = await idMappingRepository.buscar(q, Number(req.query.limite ?? 50) || 50);
      return {
        q,
        total: achados.length,
        itens: achados.map((m) => ({
          entityType: m.entityType,
          rmCode: m.rmCode,
          toddleId: m.toddleId,
          state: m.state,
          curriculumId: m.curriculumId,
          archiveReason: m.archiveReason,
          lastSeenInScopeAt: m.lastSeenInScopeAt,
        })),
      };
    },
  );

  /**
   * Vários `rm_code` apontando para o mesmo `toddle_id`.
   *
   * A rota NÃO chama isto de erro, e a diferença importa: o índice 1:1 do banco
   * cobre STUDENT, STAFF e PARENT porque só para pessoas a relação é
   * necessariamente um-para-um. Para year group, muitos-para-um é o desenho (a
   * migration 003 existe para isso). Aqui é "olhe", não "conserte".
   */
  app.get('/mappings/duplicatas', { preHandler: exigirPapel(['viewer']) }, async () => {
    const dups = await idMappingRepository.duplicatasPorToddleId();
    return {
      total: dups.length,
      itens: dups,
      leia:
        'N para 1 é legítimo em YEAR_GROUP e em turma; para STUDENT, STAFF e PARENT o banco já ' +
        'impede. Isto é uma lista para olhar, não uma lista de defeitos.',
    };
  });

  /** Mapeamentos que apontam para id que não existe mais no destino. */
  app.get<{ Querystring: { entityType?: string; curriculumId?: string } }>(
    '/mappings/orfaos',
    { preHandler: exigirPapel(['viewer']) },
    async (req, reply) => {
      const entityType = req.query.entityType as EntityType | undefined;
      if (!entityType || !ENTITY_TYPES.includes(entityType)) {
        return reply.code(400).send({ erro: 'entityType inválido ou ausente', aceitos: ENTITY_TYPES });
      }
      if (!ORFAOS_VERIFICAVEIS[entityType]) {
        return reply.code(422).send({
          erro: `órfão não é verificável para ${entityType}`,
          motivo: MOTIVO_NAO_VERIFICAVEL,
          verificaveis: Object.keys(ORFAOS_VERIFICAVEIS),
        });
      }

      let idsVivos: string[];
      if (entityType === 'YEAR_GROUP') {
        const { curriculumId } = req.query;
        if (!curriculumId) {
          return reply.code(400).send({
            erro: 'curriculumId é obrigatório para YEAR_GROUP',
            motivo:
              'sem currículo a API devolve a organização achatada, onde nomes de year group colidem ' +
              'entre currículos — foi assim que um de-para foi feito para a escada errada',
          });
        }
        idsVivos = (await toddleClient.getYearGroups(curriculumId)).map((y) => y.id);
      } else {
        idsVivos = (await toddleClient.listClasses())
          .map((c) => String((c as { id?: unknown }).id ?? ''))
          .filter(Boolean);
      }

      // Lista vazia = "não sei", NUNCA "tudo órfão". A mesma armadilha que
      // `findActiveNotIn` documenta para o escopo do sync: uma leitura falha não
      // pode ser interpretada como "todos saíram".
      if (idsVivos.length === 0) {
        return reply.code(503).send({
          erro: 'o Toddle não devolveu nenhum id — leitura tratada como "não sei"',
          motivo: 'com lista vazia TODA linha pareceria órfã, e agir sobre isso arquivaria a base inteira',
        });
      }

      const orfaos = await idMappingRepository.orfaos(entityType, idsVivos);
      return {
        entityType,
        idsVivosNoToddle: idsVivos.length,
        total: orfaos.length,
        fonte: ORFAOS_VERIFICAVEIS[entityType],
        itens: orfaos.map((m) => ({
          rmCode: m.rmCode,
          toddleId: m.toddleId,
          curriculumId: m.curriculumId,
          lastSeenInScopeAt: m.lastSeenInScopeAt,
        })),
      };
    },
  );

  /**
   * Currículos do Toddle, para a tela não pedir que alguém digite um id de cor.
   *
   * A tela anterior tinha um campo de texto livre para `curriculumId`. Digitar id
   * à mão num sistema onde os dois currículos têm year groups de nomes duplicados
   * é o caminho mais curto para auditar a escada errada e concluir que está tudo
   * bem.
   */
  app.get('/curriculos', { preHandler: exigirPapel(['viewer']) }, async () => ({
    organizacao: tenantConfig.toddle.organizationId,
    itens: await toddleClient.listCurriculums(),
  }));

  /** As propostas esperando decisão, com snapshot para a tela montar o diff. */
  app.get('/propostas', { preHandler: exigirPapel(['viewer']) }, async () => ({
    formas: FORMAS,
    itens: await propostasPendentes(),
  }));

  /**
   * Propõe mudança de vínculo. NÃO aplica nada.
   *
   * `mapping_manager` propõe; decidir exige `approver`. Os dois papéis existem no
   * CHECK da migration 006 desde antes desta tela, e é exatamente esta a divisão
   * que eles descrevem.
   */
  app.post<{ Body: PropostaDeVinculo }>(
    '/propostas',
    { preHandler: exigirPapel(['mapping_manager']) },
    async (req, reply) => {
      const erro = validarProposta(req.body ?? ({} as PropostaDeVinculo));
      if (erro) return reply.code(400).send({ erro });

      try {
        const r = await propor(req.body, req.autorizacao!.userIdentityId, atorDaRequisicao(req));
        return reply.code(201).send({
          ...r,
          proximoPasso:
            'nada foi escrito no de-para. Alguém com papel de aprovação decide, e o snapshot é ' +
            'revalidado antes de gravar — se a linha mudar no meio, a aprovação perde validade',
        });
      } catch (e) {
        return reply.code(409).send({ erro: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  /**
   * Decide uma proposta. Aprovar APLICA, na mesma transação da auditoria.
   *
   * O `motivo` é obrigatório e não é formulário: num `revincular`, o `antes` do
   * evento de auditoria é o ÚNICO lugar onde o vínculo anterior continua
   * existindo — a chave única impede guardar a linha velha ao lado da nova.
   */
  app.post<{ Params: { id: string }; Body: { decisao?: 'approved' | 'rejected'; motivo?: string } }>(
    '/propostas/:id/decidir',
    { preHandler: exigirPapel(['approver']) },
    async (req, reply) => {
      const { decisao, motivo } = req.body ?? {};
      if (decisao !== 'approved' && decisao !== 'rejected') {
        return reply.code(400).send({ erro: 'decisao deve ser "approved" ou "rejected"' });
      }
      if (!motivo?.trim() || motivo.trim().length < 10) {
        return reply.code(400).send({
          erro: 'motivo é obrigatório (mín. 10 caracteres)',
          porque:
            'num revincular, o valor anterior do vínculo sobrevive só no evento de auditoria — o ' +
            'motivo é o que explica a mudança para quem ler daqui a seis meses',
        });
      }

      const r = await decidirProposta(
        req.params.id,
        req.autorizacao!.userIdentityId,
        decisao,
        motivo.trim(),
        atorDaRequisicao(req),
      );
      if (!r.ok) return reply.code(409).send({ erro: r.erro });
      return r;
    },
  );
};
