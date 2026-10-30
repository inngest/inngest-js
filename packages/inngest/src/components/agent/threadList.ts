/**
 * @module
 * EXPERIMENTAL: listing the threads of an agent, or of a session, with an
 * Insights query over the `agent/message` events. A thread exists once a
 * message was sent to it, so the events are the list.
 *
 * EXPERIMENTAL and unverified on Inngest Cloud: the query below has not been
 * run against Insights yet, and the OSS Dev Server does not serve Insights (it
 * answers 501). Pass `query` to read the events some other way, for example in
 * a test or from your own store.
 */

import type { Inngest } from "../Inngest.ts";
import {
  agentMessageEvent,
  agentRequestEvent,
  agentSteerEvent,
  agentStopEvent,
  getThread,
  type ThreadHandle,
} from "./thread.ts";

/**
 * Runs an Insights SQL query and returns its rows, each a list of values in
 * the order of `columns`.
 */
export type InsightsQuery = (
  sql: string,
) => Promise<{ columns: string[]; rows: unknown[][] }>;

/**
 * Options of `threads.list()` on an agent.
 */
export interface ThreadListOptions {
  /**
   * Only the threads of this session.
   */
  session?: string;

  /**
   * The most threads to return, most recently messaged first. Default 100.
   */
  limit?: number;

  /**
   * How to run the query. Default: the client's Insights API.
   */
  query?: InsightsQuery;
}

/**
 * The threads of one agent, reached as `.threads` on an agent.
 */
export interface ThreadList {
  /**
   * The threads that were sent a message, most recent first, as handles.
   * Experimental: the Insights query is unverified on Inngest Cloud.
   */
  list(
    /**
     * Session filter, limit and query override.
     */
    options?: ThreadListOptions,
  ): Promise<ThreadHandle[]>;
}

/**
 * A SQL string literal.
 */
function literal(
  /**
   * The text.
   */
  value: string,
): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/**
 * The Insights query that lists the threads of an agent.
 *
 * Not yet checked against Insights: the columns of the events table are
 * assumed to be `name`, `data`, `meta` and `ts`.
 */
export function threadListSql(
  /**
   * The agent, as `"appId/functionId"`.
   */
  agent: string,

  /**
   * Session filter and limit.
   */
  options: Pick<ThreadListOptions, "session" | "limit"> = {},
): string {
  const session = "JSONExtractString(meta, 'sessions', 'agent_session')";
  const filters = [
    `name IN (${[agentMessageEvent, agentSteerEvent, agentStopEvent, agentRequestEvent].map(literal).join(", ")})`,
    `JSONExtractString(data, 'agent') = ${literal(agent)}`,
    ...(options.session === undefined
      ? []
      : [`${session} = ${literal(options.session)}`]),
  ];
  const asked = options.limit ?? 100;
  const limit = Number.isFinite(asked) ? Math.max(1, Math.floor(asked)) : 100;

  return [
    `SELECT JSONExtractString(data, 'thread') AS thread, max(${session}) AS session, max(ts) AS last_message_at`,
    "FROM events",
    `WHERE ${filters.join(" AND ")}`,
    "GROUP BY thread",
    "ORDER BY last_message_at DESC",
    `LIMIT ${limit}`,
  ].join("\n");
}

/**
 * EXPERIMENTAL: Lists the threads of an agent.
 */
export async function listThreads(
  /**
   * Inngest client.
   */
  client: Inngest.Any,

  /**
   * The agent, as `"appId/functionId"`.
   */
  agent: string,

  /**
   * Session filter, limit and query override.
   */
  options: ThreadListOptions = {},

  /**
   * Builds the handle of a thread. Default: a plain handle.
   */
  make: (key: string, session: string) => ThreadHandle = (key, session) => {
    return getThread(client, agent, key, { session });
  },
): Promise<ThreadHandle[]> {
  const query: InsightsQuery =
    options.query ??
    ((sql) => {
      return client.queryInsights(sql);
    });
  const { columns, rows } = await query(threadListSql(agent, options));
  const threadAt = columns.indexOf("thread");
  const sessionAt = columns.indexOf("session");

  if (threadAt === -1) {
    throw new Error(
      `Listing threads: the query returned no "thread" column (got ${columns.join(", ")}).`,
    );
  }

  return rows.map((row) => {
    const key = String(row[threadAt]);
    const session = sessionAt === -1 ? undefined : row[sessionAt];

    return make(key, typeof session === "string" && session ? session : key);
  });
}
