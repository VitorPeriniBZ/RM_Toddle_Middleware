import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/**
 * O que basta para executar SQL: o pool OU um client dentro de uma transação.
 *
 * Existe para os repositórios que precisam gravar na MESMA transação de outra
 * coisa — o caso que motivou o tipo é `audit_event`, que tem de ser escrito
 * junto com a mudança que ele descreve. Se a auditoria fosse gravada por fora,
 * numa segunda conexão, um erro entre as duas deixaria mudança sem trilha (ou
 * trilha sem mudança), e a tabela existe justamente para isso não acontecer.
 *
 * Repositório que aceita `Executor` serve aos dois usos sem duplicar consulta:
 * quem não está numa transação passa o pool, que é o default.
 */
export interface Executor {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

/** Só para deixar explícito que Pool e PoolClient satisfazem o contrato. */
export type ExecutorConcreto = Pool | PoolClient;
