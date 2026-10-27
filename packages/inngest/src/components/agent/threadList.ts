/**
 * @module
 * EXPERIMENTAL: listing the threads of an agent, or of a session, with an
 * Insights query over the `agent/message` events. A thread exists once a
 * message was sent to it, so the events are the list.
 *
 * Insights is not served by the OSS Dev Server (it answers 501), so listing
 * works against Inngest Cloud. Pass `query` to read the events some other
 * way, for example in a test or from your own store.
 */

import type { InngestApi } from "../../api/api.ts";
import type { Inngest } from "../Inngest.ts";
import { agentMessageEvent, getThread, type ThreadHandle } from "./thread.ts";

/**
 * Runs an Insights SQL query and returns its rows, each a list of values in
 * the order of `columns`.
 */
export type InsightsQuery = (
  sql: string,
) => Promise<{ columns: string[]; rows: unknown[][] }>;

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

export interface ThreadList {
  /**
   * The threads that were sent a message, most recent first, as handles.
   * @param options Session filter, limit and query override.
   */
  list(options?: ThreadListOptions): Promise<ThreadHandle[]>;
}

/**
 * A SQL string literal.
 * @param value The text.
 */
function literal(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/**
 * The Insights query that lists the threads of an agent.
 *
 * Not yet checked against Insights: the columns of the events table are
 * assumed to be `name`, `data`, `meta` and `ts`.
 * @param agent The agent, as `"appId/functionId"`.
 * @param options Session filter and limit.
 */
export function threadListSql(
  agent: string,
  options: Pick<ThreadListOptions, "session" | "limit"> = {},
): string {
  const session = "JSONExtractString(meta, 'sessions', 'agent_session')";
  const filters = [
    `name = ${literal(agentMessageEvent)}`,
    `JSONExtractString(data, 'agent') = ${literal(agent)}`,
    ...(options.session === undefined
      ? []
      : [`${session} = ${literal(options.session)}`]),
  ];
  const limit = Math.max(1, Math.floor(options.limit ?? 100));

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
 * @param client Inngest client.
 * @param agent The agent, as `"appId/functionId"`.
 * @param options Session filter, limit and query override.
 * @param make Builds the handle of a thread. Default: a plain handle.
 */
export async function listThreads(
  client: Inngest.Any,
  agent: string,
  options: ThreadListOptions = {},
  make: (key: string, session: string) => ThreadHandle = (key, session) => {
    return getThread(client, agent, key, { session });
  },
): Promise<ThreadHandle[]> {
  const query: InsightsQuery =
    options.query ??
    ((sql) => {
      // The client keeps its API private; listing is the one other reader.
      const api = (client as unknown as { inngestApi: InngestApi }).inngestApi;

      return api.queryInsights(sql);
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
