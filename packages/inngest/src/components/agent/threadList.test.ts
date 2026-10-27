/**
 * @module
 * Tests for listing threads against a fake Insights query.
 */
import type { Inngest } from "../Inngest.ts";
import { listThreads, threadListSql } from "./threadList.ts";

const client = { id: "app", env: null } as unknown as Inngest.Any;

describe("listing threads", () => {
  test("the query filters by agent, and by session when given", () => {
    const all = threadListSql("app/bot");
    const one = threadListSql("app/bot", { session: "it's", limit: 5 });

    expect(all).toContain("name = 'agent/message'");
    expect(all).toContain("JSONExtractString(data, 'agent') = 'app/bot'");
    expect(all).not.toContain("agent_session') =");
    expect(all).toContain("LIMIT 100");
    expect(one).toContain("agent_session') = 'it\\'s'");
    expect(one).toContain("LIMIT 5");
  });

  test("each row is a handle of that thread, in its session", async () => {
    const sqls: string[] = [];
    const threads = await listThreads(client, "app/bot", {
      session: "s1",
      async query(sql) {
        sqls.push(sql);

        return {
          columns: ["thread", "session", "last_message_at"],
          rows: [
            ["t1", "s1", 2],
            ["t2", null, 1],
          ],
        };
      },
    });

    expect(sqls).toHaveLength(1);
    expect(
      threads.map((thread) => {
        return [thread.agent, thread.key, thread.session];
      }),
    ).toEqual([
      ["app/bot", "t1", "s1"],
      ["app/bot", "t2", "t2"],
    ]);
  });

  test("a result without a thread column is an error", async () => {
    await expect(
      listThreads(client, "app/bot", {
        async query() {
          return { columns: ["x"], rows: [] };
        },
      }),
    ).rejects.toThrow('no "thread" column');
  });
});
