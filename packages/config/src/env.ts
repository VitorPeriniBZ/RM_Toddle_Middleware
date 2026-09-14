import 'dotenv/config';
import { z } from 'zod';

/**
 * Todas as credenciais e parâmetros do middleware vêm de variáveis de
 * ambiente, validadas com Zod na inicialização. O processo NÃO sobe com
 * configuração inválida (fail-fast).
 */
const stringBool = z.enum(['true', 'false']).default('true').transform((v) => v === 'true');

const envSchema = z.object({
  // --- TOTVS RM Educacional (API TTALK REST) — OPCIONAL ---
  // No CloudTOTVS o REST educacional em geral NÃO está publicado; a fonte de
  // dados do RM é o wsConsultaSQL (SOAP) abaixo. Deixe vazio se não houver REST.
  TOTVS_RM_HOST: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  TOTVS_RM_AUTH_HEADER: z.string().optional(),
  TOTVS_RM_PAGE_SIZE: z.coerce.number().int().positive().default(200),
  /** CSV de MajorStatus/TermStatus "ativos" — domínios não documentados nos specs. Vazio = aceita todos. */
  RM_ACTIVE_TERM_STATUSES: z.string().default(''),

  // --- TBC / wsConsultaSQL (SOAP) — fonte de dados do RM ---
  RM_WS_BASEURL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  RM_WS_USER: z.string().optional(),
  RM_WS_PASS: z.string().optional(),
  /** Sistema RM das Sentenças educacionais (normalmente "S"). */
  RM_WS_SISTEMA: z.string().default('S'),
  /** Código da Sentença que devolve o roster de alunos (obrigatória p/ o Fluxo 1 via SOAP). */
  RM_SENTENCA_STUDENTS: z.string().optional(),
  /** Período letivo passado à Sentença de alunos (ex.: "2026"). */
  RM_CODPERLET: z.string().optional(),
  /** Sentenças do Fluxo 2 (roadmap). */
  RM_SENTENCA_FREQUENCIA: z.string().optional(),
  RM_SENTENCA_NOTAS: z.string().optional(),
  /**
   * Turma-disciplina-PROFESSOR. É a única fonte que traz o docente: o
   * `EduTurmaDiscData` (usado por `reconciliar:turmas`) devolve a turma-disciplina
   * mas NÃO o professor alocado. Publicada no RM em 10/08/2026 — a especificação
   * em docs/rm-sentencas/TODDLE.TURMADISC.ESPEC.md foi escrita quando ela ainda
   * dava SOAP Fault, e diz que sem ela "não há sincronização automática
   * possível". Passou a haver.
   */
  RM_SENTENCA_TURMADISC: z.string().optional(),
  /**
   * Turmas que existem no RM por conveniência de LANÇAMENTO e não devem virar
   * turma no Toddle. Regex aplicada ao `COD_TURMA`.
   *
   * Na EAV é a "turma Gerenciada" (`IG`): quando o mesmo professor dá a mesma
   * disciplina para alunos da turma A e da B, o portal atual do RM deixa ele
   * lançar tudo numa turma única. É agregação de interface, não aula — não tem
   * aluno matriculado, nota nem frequência (verificado em 11/08/2026: 0 nas três,
   * contra 174 turma-disciplina com frequência).
   *
   * NÃO tem default de propósito. Vazio = nada é ignorado, e as turmas aparecem
   * como deriva — que é o comportamento correto para quem não tem essa
   * convenção. Cravar `IG` aqui no código seria enfiar regra de uma escola no
   * núcleo white label.
   */
  RM_TURMAS_IGNORADAS: z.string().optional(),
  /** Responsáveis (ex.: TODDLE.RESP). Ver docs/rm-sentencas/TODDLE.RESP.ESPEC.md. */
  RM_SENTENCA_RESPONSAVEIS: z.string().optional(),
  RM_CODCOLIGADA: z.coerce.number().int().default(1),
  /**
   * Campus (CODFILIAL) no escopo da integração, em CSV. OBRIGATÓRIA.
   *
   * Nesta escola: 1 = Infantil + Fundamental I; 2 = campus do aeroporto
   * (Fundamental II + Médio). Só o 2 está no escopo do Toddle.
   *
   * NÃO tem default. Vazio antes significava "todos os campi", e em 31/07/2026
   * isso sincronizou 586 alunos em vez de 253 — o campus 1 inteiro foi criado no
   * Toddle e depois teve de ser arquivado um a um. Configuração ausente não pode
   * AMPLIAR escopo de dados de alunos; tem que abortar. Para incluir todos os
   * campi de propósito, declare o literal "ALL".
   */
  RM_CODFILIAL: z
    .string()
    .min(1, 'RM_CODFILIAL é obrigatória: liste os CODFILIAL em escopo (ex.: "2") ou "ALL" para todos'),

  // --- Banco do RM (SQL Server) — legado/opcional; só o Fluxo 2 escrita usaria ---
  RM_SQL_SERVER: z.string().optional(),
  RM_SQL_PORT: z.coerce.number().int().default(1433),
  RM_SQL_DATABASE: z.string().optional(),
  RM_SQL_USER: z.string().optional(),
  RM_SQL_PASSWORD: z.string().optional(),
  RM_SQL_ENCRYPT: stringBool,
  RM_SQL_TRUST_CERT: stringBool,

  // --- Toddle Open API V2 (Toddle 2.0 — modelo TeacherCourse, usado pela EAV) ---
  TODDLE_REGION: z.string().default('us-east-1'),
  TODDLE_BASE_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  TODDLE_TOKEN: z.string().min(1),
  /**
   * Organização Toddle que este processo tem permissão de escrever. OBRIGATÓRIA.
   *
   * É a `target_instance_key` da id_mapping: um mesmo RA pode ter mapeamento no
   * sandbox e na organização final sem colidir. Serve de travessa de segurança —
   * o cliente compara isto com a organização que a API devolve e ABORTA se
   * divergir. Sem isso, trocar o token aponta o sync para outra organização
   * silenciosamente, reusando ids que não existem lá.
   *
   * Sandbox atual: 404045532130986859 (Escola Americana de Vitória_Sandbox).
   */
  TODDLE_ORG_ID: z
    .string()
    .min(1, 'TODDLE_ORG_ID é obrigatória: declare a organização Toddle de destino'),
  /** GET /students exige paginação; pageSize documentado entre 100 e 400. */
  TODDLE_PAGE_SIZE: z.coerce.number().int().min(100).max(400).default(400),
  TODDLE_DEFAULT_YEAR_GROUP_ID: z.string().optional(),

  // --- Integração ---
  /** Prefixo do sourceId (ex.: "1-" para coligada). Escolha um formato e NUNCA mude. */
  SOURCE_ID_PREFIX: z.string().default(''),
  SYNC_BATCH_SIZE: z.coerce.number().int().positive().max(200).default(50),
  STUDENTS_SYNC_CRON: z.string().default('0 3 * * *'),

  // --- Multi-tenant ---
  /**
   * Escola (tenant) que este processo atende. OBRIGATÓRIA.
   *
   * O middleware é white label: a mesma base atende N escolas, e cada linha da
   * id_mapping pertence a uma. Sem tenant declarado uma consulta poderia
   * devolver mapeamento de outra escola — por isso não há default. Enquanto o
   * worker roda por deploy, isto vem do .env; quando a API existir, o tenant
   * será resolvido por requisição/job e esta variável passa a ser só o padrão
   * dos comandos de linha.
   */
  TENANT_SLUG: z
    .string()
    .min(1, 'TENANT_SLUG é obrigatória: informe o slug da escola (ex.: "eav")'),

  // --- API (plano de controle) ---
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3333),
  API_HOST: z.string().default('127.0.0.1'),
  /**
   * Modo de autenticação. OBRIGATÓRIO e sem default — a API expõe dados de
   * alunos (PII), e "esqueci de configurar" não pode virar "aberta".
   *
   *   google-oidc  produção: exige Bearer token do Google, valida assinatura
   *                (JWKS), audience, expiração e a claim `hd` do Workspace.
   *   localhost    desenvolvimento: dispensa token, mas SÓ escuta em 127.0.0.1 e
   *                recusa subir com NODE_ENV=production. Loga aviso em toda
   *                requisição, de propósito — não deve passar despercebido.
   */
  API_AUTH_MODE: z.enum(['google-oidc', 'localhost'], {
    errorMap: () => ({
      message: 'API_AUTH_MODE é obrigatória: "google-oidc" (produção) ou "localhost" (dev)',
    }),
  }),
  /**
   * Origens autorizadas a chamar a API (CORS), em CSV. Allowlist explícita, nunca
   * "*": a UI manda o header Authorization, e com origem aberta qualquer página
   * no navegador do usuário poderia usar o token dele contra esta API.
   */
  WEB_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  /** Client ID do Google — é o `aud` esperado no token. Exigido no modo google-oidc. */
  GOOGLE_CLIENT_ID: z.string().optional(),
  /** Domínios do Workspace aceitos (claim `hd`), em CSV. Exigido no modo google-oidc. */
  GOOGLE_ALLOWED_HD: z.string().optional(),

  // --- Infra do middleware ---
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.string().default('development'),

  // ─── SESSÃO DO PLANO DE CONTROLE ─────────────────────────────────────────
  //
  // Antes a "sessão" era o ID token do Google guardado em memória: 1 hora de
  // prazo (do Google, não nosso) e perdida a cada recarregar de página. E não
  // havia como deslogar ninguém.
  //
  // Com a sessão no banco, cortar um acesso é imediato — então estes prazos são
  // decisão de EXPERIÊNCIA, não de contenção, e podem ser generosos.

  /** Sem uso por este tempo, a sessão morre. 8h cobre um dia de trabalho inteiro. */
  SESSAO_OCIOSA_MS: z.coerce.number().int().positive().default(8 * 60 * 60 * 1000),
  /** Teto de vida, mesmo em uso contínuo. NÃO desliza. */
  SESSAO_ABSOLUTA_MS: z.coerce.number().int().positive().default(7 * 24 * 60 * 60 * 1000),
  /**
   * Teto menor para quem administra o tenant: é o cookie cujo roubo tem o pior
   * resultado — mudar o horário de um job que escreve em registro acadêmico.
   */
  SESSAO_ABSOLUTA_ADMIN_MS: z.coerce.number().int().positive().default(24 * 60 * 60 * 1000),
  /**
   * Liga `Secure` no cookie fora de produção. Em produção é IMPLÍCITO e não há
   * como desligar — ver a checagem em `validarCoerencia`.
   */
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),

  // --- Alerta por AUSÊNCIA de sucesso (dead man's switch) ---
  //
  // URL de um monitor externo (Healthchecks.io, Uptime Kuma, ntfy com cron
  // check...). O job dá um ping ao terminar; o SERVIÇO EXTERNO alerta quando o
  // ping NÃO chega.
  //
  // A inversão é o ponto inteiro, e é o que faltava: entre 12 e 20/08/2026 a
  // integração ficou 8 dias morta e ninguém soube. Um alerta construído DENTRO
  // deste processo não teria disparado — o processo era justamente o que estava
  // parado. Alerta por silêncio sobrevive a container morto, Redis fora, senha
  // expirada e Sentença apagada.
  //
  // Vazias = desligado, sem quebrar nada. Ninguém é obrigado a ter monitor.
  //
  // LIMIAR, no monitor externo: o cron é 4x ao dia, mas os intervalos são
  // DESIGUAIS — 03:00, 09:00, 12:00, 16:00 deixa uma janela de 11h entre 16:00 e
  // 03:00. Limiar de 8h alertaria toda madrugada, e alerta que cria ruído é
  // alerta que passa a ser ignorado. Use ~13h (ou "grace" de 1h sobre 12h).
  HEARTBEAT_URL_ALUNOS: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  HEARTBEAT_URL_PROFESSORES: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  HEARTBEAT_URL_NOTAS: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  HEARTBEAT_URL_FREQUENCIA: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  /** Timeout do ping. Curto de propósito: monitor lento não pode atrasar o job. */
  HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  // --- Plano de CONTROLE: agenda no banco, alerta e reconciliação ---
  //
  // A partir da tela de agendamento, a VERDADE do horário de cada fluxo é a
  // tabela `flow_schedule` no Postgres, não o ambiente. As variáveis abaixo são
  // de OPERAÇÃO da instância (com que frequência reconciliar, para onde alertar),
  // não de escola — continuam aqui pelo mesmo critério de sempre.
  //
  // `STUDENTS_SYNC_CRON` e `NOTA_SYNC_ATIVO`/`NOTA_SYNC_CRON` continuam válidas,
  // mas agora só como SEMENTE: valem na primeira subida, quando a linha do fluxo
  // ainda não existe no banco. Depois disso o banco manda, e mudar a variável não
  // muda comportamento. Ver apps/worker/src/agenda/reconciliar.ts.

  /**
   * Webhook de alerta (Slack, Discord, ntfy, Teams...). Vazio = desligado.
   *
   * É COMPLEMENTAR ao heartbeat, não substituto, e a diferença importa: o
   * heartbeat é um terceiro reclamando do SILÊNCIO — cobre este processo morto.
   * Este webhook é o processo falando de dentro, e cobre o que o silêncio não
   * pega: job que morreu mas o worker segue vivo (foi o caso dos 62 jobs na DLQ,
   * sete dias sem ninguém saber), e "nenhum run bem-sucedido na janela esperada"
   * enquanto tudo parece de pé.
   */
  ALERTA_WEBHOOK_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  /** Timeout do POST de alerta. Curto: canal lento não pode atrasar o worker. */
  ALERTA_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  /**
   * Intervalo do poll de reconciliação da agenda.
   *
   * POR QUE POLL, e não só pub/sub: pub/sub é entrega no máximo uma vez. Se a
   * notificação se perder — worker reiniciando, Redis reiniciando, justamente os
   * cenários que já custaram caro aqui —, o poll converge sozinho. O pub/sub
   * existe por cima dele, para a tela responder na hora; nunca no lugar dele.
   */
  AGENDA_RECONCILIA_MS: z.coerce.number().int().min(5_000).default(60_000),
  /**
   * Intervalo mínimo entre dois disparos que a tela aceita salvar, em minutos.
   *
   * Guarda contra o `* * * * *` digitado por engano. Com `concurrency: 1` o
   * sintoma não seria execução concorrente, e sim BACKLOG crescente: a fila
   * enche mais rápido do que o worker consome, e o atraso só aparece horas
   * depois. Cada passada de nota ainda lê ~7 mil linhas de Sentença no RM.
   */
  AGENDA_INTERVALO_MIN_MINUTOS: z.coerce.number().int().positive().default(15),
  /**
   * Intervalo do vigia de "nenhum sucesso na janela". Ver apps/worker/src/agenda/vigia.ts.
   */
  VIGIA_INTERVALO_MS: z.coerce.number().int().min(60_000).default(900_000),

  /**
   * Guarda de desvio de contagem, em pontos percentuais. O sync é completo: se o
   * RM voltar a servir uma cópia ANTIGA da base — que já aconteceu em 13-15/08 —
   * ele sobrescreveria os alunos no Toddle com dado velho e `failed=0`, sem um
   * único log de erro. Esta é a única defesa contra isso.
   *
   * 0 = desligado.
   */
  SYNC_DESVIO_MAX_PCT: z.coerce.number().min(0).max(100).default(10),

  // --- Teto de volume da ESCRITA no RM ---
  //
  // As guardas por registro (`decidirEscrita`) são cegas para "quantas?". Um
  // JOIN errado no de-para virando produto cartesiano produz milhares de
  // decisões individualmente CORRETAS — o erro só existe no agregado.
  //
  // Estes quatro números são a única guarda que olha o tamanho do plano.
  /** Acima disto o run é RECUSADO: o número é a evidência do defeito. */
  WRITE_TETO_ABSOLUTO: z.coerce.number().int().positive().default(5_000),
  /** Percentual acima do histórico que exige aprovação humana. */
  WRITE_DESVIO_MAX_PCT: z.coerce.number().min(0).default(50),
  /** Percentual do escopo que, sozinho, exige aprovação. */
  WRITE_TETO_ESCOPO_PCT: z.coerce.number().min(0).max(100).default(30),
  /**
   * Abaixo disto nunca pede aprovação.
   *
   * Percentual sobre número pequeno é ruído: 2 → 6 linhas é +200% e não
   * significa nada. Sem o piso, correção miúda viraria pedido de aprovação — e
   * aprovação que aparece por nada é aprovação que alguém passa a dar sem ler.
   */
  WRITE_PISO_SEM_APROVACAO: z.coerce.number().int().min(0).default(50),

  // --- Via de NOTA, Toddle -> RM (automática) ---
  //
  // A única escrita AGENDADA que este projeto faz no RM. Todas as outras exigem
  // alguém digitando `--executar`, e é por isso que estas três variáveis
  // existem: a decisão de ligar é por escola, não do código.
  /**
   * Liga a via de nota agendada. Default `false`, DE PROPÓSITO.
   *
   * O middleware é white label, e escrita automática em registro acadêmico legal
   * não pode chegar numa escola nova por herança de default. Vale também como
   * interruptor: `false` e o próximo deploy para de escrever, sem alterar código.
   */
  NOTA_SYNC_ATIVO: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Frequência do poll. A API do Toddle NÃO tem webhook — verificado na
   * referência inteira em 09/09/2026 —, então "quando o professor lançar" é
   * necessariamente uma consulta periódica.
   *
   * O default cobre 6h às 22h de meia em meia hora: fora desse intervalo
   * ninguém está lançando nota, e cada passada custa uma leitura da Sentença
   * TODDLE.NOTAS (7 mil linhas) no RM.
   */
  //
  // `15,45` e nao a cada meia hora: com alunos em `:00` e professores em `:30`,
  // qualquer horario de 30 em 30 minutos cai EM CIMA de um dos dois. Medido em
  // 11/09/2026, o default antigo dava folga ZERO contra os dois — e sobreposicao
  // na janela de 300s do Toddle custou "17 de 50 alunos falharam (HTTP 429)" num
  // lote real.
  //
  // O meio do vao e o melhor possivel enquanto os outros dois estiverem em `:00`
  // e `:30`: 15 min de cada lado. Fica abaixo da convencao de 30 min, e o
  // preflight avisa — a convencao e a frequencia de 30 em 30 minutos sao
  // matematicamente incompativeis, e o conserto de verdade e o limitador
  // compartilhado, nao um cron mais esperto.
  //
  // (Comentario de LINHA de proposito: a sintaxe de cron tem `*/`, que fecharia
  // um comentario de bloco no meio da frase. Ja quebrou o build uma vez.)
  NOTA_SYNC_CRON: z.string().default('15,45 6-22 * * *'),

  // --- Turma e disciplina, RM -> de-para (somente leitura) ------------------
  //
  // Não tem interruptor de escola porque não escreve nada: ele compara e relata.
  // O Toddle não tem DELETE de turma, só arquivar — criar turma automaticamente
  // seria a única ação irreversível deste projeto, e é a que ele não faz.
  //
  // 05:00 é escolhido, não sorteado: alunos roda 03:00/09:00, professores
  // 03:30/09:30 e a nota das 06:00 às 22:00. Cinco da manhã é o único horário
  // que não encosta em nenhum dos três na janela de 300s do Toddle.
  TURMAS_SYNC_CRON: z.string().default('0 5 * * *'),

  // --- Via de FREQUÊNCIA, Toddle -> RM (automática) ------------------------
  //
  // A SEGUNDA escrita agendada em registro acadêmico, e a mais delicada das
  // duas: o TOTVS é a fonte de verdade da frequência e já tem ~14,6 mil faltas
  // lançadas à mão. Escrever por cima de ausência marcada por um humano apaga
  // trabalho de gente — por isso `decidirEscrita` existe, e por isso o default
  // aqui é `false`.
  /**
   * Liga a via de frequência agendada. Default `false`, pelo mesmo motivo que
   * `NOTA_SYNC_ATIVO`: escrita automática em registro acadêmico não pode chegar
   * a uma escola nova por herança de default.
   */
  FREQ_SYNC_ATIVO: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  //
  // 23:00, uma vez por dia. A chamada do Toddle é lançada ao longo do dia e não
  // há webhook; rodar de madrugada pega o dia inteiro fechado, em vez de
  // escrever meia aula e voltar depois.
  //
  // (Comentario de LINHA porque a sintaxe de cron tem `*/`, que fecharia um
  // comentario de bloco no meio da frase.)
  FREQ_SYNC_CRON: z.string().default('0 23 * * *'),
  /**
   * Quantos dias para trás a passada reprocessa.
   *
   * Não é "desde a última vez": a janela fixa torna cada passada IDEMPOTENTE e
   * independente do histórico — perder uma noite não perde dado, porque a noite
   * seguinte cobre o mesmo intervalo. O guarda de decisão já resolve o que
   * mudou, então reprocessar é barato e não reescreve o que está igual.
   *
   * Três dias cobre o fim de semana: uma falha na sexta ainda é recuperada pela
   * passada de segunda.
   */
  FREQ_SYNC_DIAS: z.coerce.number().int().positive().max(30).default(3),

  // --- Limitador de taxa COMPARTILHADO do Toddle ----------------------------
  //
  // A janela de rate limit e da ORGANIZACAO: alunos, professores e notas gastam
  // a mesma cota. Espacar cron nao cobre execucao manual, retry nem backfill —
  // em 11/09/2026 um sync manual somado ao cron estourou a janela e o lote 3 do
  // sync de alunos falhou com "17/50 alunos falharam (HTTP 429)".
  //
  // Ver packages/integrations/src/toddle/limitadorDeTaxa.ts.
  TODDLE_RATE_LIMIT_ATIVO: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  //
  // ESTIMATIVA, nao numero conhecido. O Toddle responde 429 dizendo "try again
  // after 300 seconds" — o CASTIGO, nao a COTA. Medido: ~260 chamadas em ~4 min
  // passam; dois syncs sobrepostos na mesma janela falham. Logo a cota esta
  // acima de 260 e abaixo de ~520. 250 fica deliberadamente abaixo do menor
  // valor que sabemos passar. Quem descobrir o numero real, corrija aqui.
  TODDLE_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(250),
  TODDLE_RATE_LIMIT_JANELA_S: z.coerce.number().int().positive().default(300),
  /**
   * Recusar nota cuja etapa esteja com `SETAPAS.DISPONIVELALUNOS='N'`?
   *
   * Default `false`, e a mudança em relação ao script é deliberada. A guarda
   * nasceu do fluxo INVERSO (RM -> Toddle), onde escrever significava PUBLICAR
   * nota provisória para a família. Nesta direção não: `DISPONIVELALUNOS` é a
   * flag DO RM que controla o que o aluno vê, e gravar em etapa não liberada
   * deixa a nota no banco sem exibi-la a ninguém. A visibilidade continua nas
   * mãos da escola, onde sempre esteve.
   *
   * Com `true` a via não escreve nada nesta escola: a flag vem 'N' em 100% das
   * 7.268 notas medidas.
   */
  NOTA_EXIGIR_ETAPA_LIBERADA: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Quais `assessmentType` do Toddle viram nota no RM. CSV de prefixos.
   *
   * Medido em 09/09/2026, os 223 assignments do sandbox se dividem em oito
   * tipos: `learning_engagement/le` (111), `assessment/fmt` (38),
   * `learning_engagement/` (30), `assessment/pt` (16), `ai_tutor/ai_tutor` (12),
   * `worksheet/worksheet` (6), `assessment/pri` (6) e `assessment/` (4).
   *
   * O default é `assessment` — o que o professor cria clicando "Avaliação" na
   * interface. Nem toda tarefa é prova: `learning_engagement` e `ai_tutor`
   * viram nota no boletim ou não? É decisão da escola, e por isso é
   * configuração e não constante.
   */
  NOTA_TIPOS_ELEGIVEIS: z.string().default('assessment'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Logger ainda não existe neste ponto do bootstrap
  // eslint-disable-next-line no-console
  console.error(
    'Variáveis de ambiente inválidas:\n',
    JSON.stringify(parsed.error.flatten().fieldErrors, null, 2),
  );
  process.exit(1);
}

const raw = parsed.data;

// Validações que cruzam campos — o Zod por campo não alcança.
const erros: string[] = [];

if (raw.API_AUTH_MODE === 'google-oidc') {
  if (!raw.GOOGLE_CLIENT_ID) erros.push('API_AUTH_MODE=google-oidc exige GOOGLE_CLIENT_ID');
  if (!raw.GOOGLE_ALLOWED_HD) {
    erros.push(
      'API_AUTH_MODE=google-oidc exige GOOGLE_ALLOWED_HD (domínios do Workspace aceitos). ' +
        'Sem isso, qualquer conta Google entraria.',
    );
  }
}

if (raw.API_AUTH_MODE === 'localhost') {
  // Fail-closed: modo sem token só existe para desenvolvimento local.
  if (raw.NODE_ENV === 'production') {
    erros.push('API_AUTH_MODE=localhost é proibido com NODE_ENV=production');
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(raw.API_HOST)) {
    erros.push(
      `API_AUTH_MODE=localhost exige API_HOST local (recebido "${raw.API_HOST}"). ` +
        'Expor a API sem autenticação em outra interface publicaria dados de alunos.',
    );
  }
}

// ─── COOKIE DE SESSÃO: FAIL-CLOSED ──────────────────────────────────────────
//
// Produção IMPLICA `Secure`; a env só serve para LIGAR fora de produção. Fazer
// `secure: COOKIE_SECURE === 'true'` deixaria uma env esquecida mandar o cookie
// de sessão em texto plano, sem nenhum sinal de que algo está errado.
const cookieSeguro = raw.NODE_ENV === 'production' || raw.COOKIE_SECURE === 'true';
if (raw.NODE_ENV === 'production' && !cookieSeguro) {
  erros.push('Cookie de sessão sem `Secure` em produção');
}

if (erros.length > 0) {
  // eslint-disable-next-line no-console
  console.error('Configuração inválida:\n' + erros.map((e) => ' - ' + e).join('\n'));
  process.exit(1);
}

export const env = {
  ...raw,
  /** Base URL do Toddle: explícita ou montada pela região. */
  TODDLE_BASE_URL: raw.TODDLE_BASE_URL ?? `https://${raw.TODDLE_REGION}-production-apis.toddleapp.com`,

  /** `Secure` no cookie de sessão. Produção implica; ver a checagem acima. */
  COOKIE_SEGURO: cookieSeguro,
  /**
   * Nome do cookie.
   *
   * O prefixo `__Host-` é uma trava do lado do NAVEGADOR: ele recusa o cookie se
   * não vier com Secure, Path=/ e SEM Domain. Nenhum erro de configuração no
   * servidor consegue desfazer isso. Fora de produção (sem Secure) o prefixo é
   * impossível, e aí vale o nome simples.
   */
  COOKIE_NOME: cookieSeguro ? '__Host-rmtoddle_sessao' : 'rmtoddle_sessao',
};

/** Fonte de dados do RM via SOAP (wsConsultaSQL) — usada no Fluxo 1. */
/**
 * @deprecated Use `rmSoapConfigurado(cfg)` de tenantConfig.ts.
 *
 * Esta constante é derivada do AMBIENTE, então responde "o wsConsultaSQL do
 * DEPLOY está configurado?" — não "o da ESCOLA X está?". Continua aqui porque a
 * validação cruzada logo abaixo a usa, e ali o ambiente é a pergunta certa.
 */
export const isRmSoapConfigured = Boolean(
  raw.RM_WS_BASEURL && raw.RM_WS_USER && raw.RM_WS_PASS,
);

/** Acesso direto ao banco (mssql) — legado; só o Fluxo 2 escrita usaria. */
export const isRmSqlConfigured = Boolean(
  raw.RM_SQL_SERVER && raw.RM_SQL_DATABASE && raw.RM_SQL_USER && raw.RM_SQL_PASSWORD,
);
