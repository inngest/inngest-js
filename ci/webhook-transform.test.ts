/**
 * Tests for `webhook-transform.js`, the transform pasted into the Inngest
 * webhook, against real GitHub payloads: the events it makes must be the ones
 * the pipelines' triggers listen for.
 *
 * @module
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { github, githubWebhookTransform } from "@inngest/ci";

const source = readFileSync(
  new URL("./webhook-transform.js", import.meta.url),
  "utf8",
);

const squash = (code: string) => {
  return code.replace(/\s+/g, "");
};

const fixture = (name: string) => {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  );
};

interface Delivered {
  name: string;
  data: {
    ref: string;
    after: string;
    deleted: boolean;
    pull_request: { head: { sha: string } };
    repository: { full_name: string };
    _github: unknown;
  };
}

const transform = new Function(`${source}; return transform;`)() as (
  evt: unknown,
  headers: Record<string, string>,
  queryParams: Record<string, string>,
  raw: string,
) => Delivered;

const deliver = (event: string, payload: unknown) => {
  return transform(
    payload,
    { "X-GitHub-Event": event, "X-GitHub-Delivery": "delivery-1" },
    {},
    JSON.stringify(payload),
  );
};

describe("webhook-transform.js", () => {
  test("is the transform @inngest/ci ships", () => {
    assert.equal(squash(source), squash(githubWebhookTransform));
  });

  test("a pull request delivery becomes the event github.pullRequest() triggers on", () => {
    const payload = fixture("pull_request.synchronize");
    const event = deliver("pull_request", payload);
    const [trigger] = github.pullRequest({ types: ["synchronize"] });

    assert.equal(event.name, trigger?.event);
    assert.equal(
      event.data.pull_request.head.sha,
      payload.pull_request.head.sha,
    );
    assert.equal(event.data.repository.full_name, "inngest/inngest-js");
    assert.deepEqual(event.data._github, {
      event: "pull_request",
      delivery: "delivery-1",
      installationId: undefined,
    });
  });

  test("a push delivery becomes the event github.push() triggers on", () => {
    const payload = fixture("push");
    const event = deliver("push", payload);
    const [trigger] = github.push({ branches: ["main"] });

    assert.equal(event.name, trigger?.event);
    assert.equal(event.data.ref, "refs/heads/main");
    assert.equal(event.data.after, payload.after);
    assert.equal(event.data.deleted, false);
  });

  test("a check suite re-request becomes the event the pipelines re-run on", () => {
    const payload = fixture("check_suite.rerequested");
    const event = deliver("check_suite", payload) as unknown as {
      name: string;
      data: {
        check_suite: { head_sha: string };
        _github: { installationId: number };
      };
      meta: { sessions: { commit: string } };
    };

    assert.equal(event.name, "github/check_suite.rerequested");
    assert.equal(event.data.check_suite.head_sha, payload.check_suite.head_sha);
    assert.equal(event.data._github.installationId, 424242);
    assert.equal(event.meta.sessions.commit, payload.check_suite.head_sha);
  });

  test("a check run button keeps what was asked for and who asked", () => {
    const payload = fixture("check_run.requested_action");
    const event = deliver("check_run", payload) as unknown as {
      name: string;
      data: {
        requested_action: { identifier: string };
        sender: { login: string };
        check_run: { external_id: string };
      };
    };

    assert.equal(event.name, "github/check_run.requested_action");
    assert.equal(event.data.requested_action.identifier, "rerun-fresh");
    assert.equal(event.data.sender.login, "jpwilliams");
    assert.equal(event.data.check_run.external_id, "01K9RUNID:lint");
  });

  test("header names are matched in any case", () => {
    const event = transform(
      { action: "opened" },
      { "x-github-event": "pull_request" },
      {},
      "",
    );

    assert.equal(event.name, "github/pull_request.opened");
  });

  test("a delivery without an event header is not mistaken for another", () => {
    assert.equal(transform({}, {}, {}, "").name, "github/unknown");
  });
});
