/**
 * @module
 * EXPERIMENTAL: the grant a start carries. One grant travels with each start,
 * in the start event's `data["::agents"]`: readable lines that say what the
 * started run may do, and one chained HMAC over them (macaroon style).
 *
 *     iss=billing                       the app that issued the block
 *     iat=1762196400                    when
 *     until=1762801200                  unattached child: valid 7 days
 *     par=["billing/triage","billing/triage:01J.0"]   who started it
 *     run=01JRUN                        attached child: ends with this run
 *     rep=["milestone","billing/triage","billing/triage:01J.0"]   report route
 *     lend=3f9a...                      digest of what is lent
 *     grp=ab12...                       the group it joins
 *     depth=1                           levels of sub-agents still allowed
 *     start=[{"effects":"read"}]        an inherited discovery list (agents)
 *     tool=[{"app":"billing"}]          an inherited discovery list (tools)
 *     exp=1762800000                    hard end
 *
 * A grant is one or more blocks. A block begins at its `sub=` line (the
 * thread that holds it; it is left out on the wire and read from the event)
 * and holds `iss`, `iat`, `until`, `par`, `run`, `rep`, `lend` and `grp`:
 * what the holder may do. Only the last block counts for those. The
 * restriction lines (`depth`, `start`, `tool`, `exp`) count wherever they
 * are: the lowest depth wins, every list must match and the earliest `exp`
 * ends the grant, so a line can only narrow.
 *
 * The chain: each line re-signs over the previous tag. A restriction line
 * is folded in with the previous tag alone, so whoever holds a grant can add
 * one (`attenuate`) without a key and nobody can remove one. Every other line
 * is folded in with the environment's signing key as well, so only an app of
 * the environment can add `sub`, `rep` or `par`: a copy read off the bus can
 * be narrowed but not widened or given to another thread.
 *
 * A message that relies on a grant carries it with a proof, `HMAC(key
 * derived from the signature, event id, target)`. The signature is on the
 * bus and the proof's key is not, so a copy of the grant cannot be used
 * for another message.
 *
 * What this does not do: every app of an environment holds the signing key,
 * so an app can mint any grant. The platform stamps `event.data._inngest` on
 * the events it makes itself (an invoke carries the source app's internal ID,
 * a defer and `function.finished` carry the run), and deletes it from every
 * event a client sends, which is how an agent's messages, reports and starts
 * travel. There is no sender stamp to compare with the grant's issuer, so the
 * issuer is checked only against what the grant says.
 */

import hashjs from "hash.js";
import type { Inngest } from "../../../components/Inngest.ts";
import { NonRetriableError } from "../../../components/NonRetriableError.ts";
import type { NormalizedDiscoveryEntry } from "../discovery/match.ts";
import type { GrantData } from "../inbox/events.ts";
import { type EffectiveLimits, readInheritedLimits } from "./limits.ts";
import { fullMac, type SigningKeys, secretsOf } from "./relations.ts";

const { sha256 } = hashjs;

/**
 * How long an unattached child's grant lasts, in seconds.
 */
export const unattachedGrantSeconds = 7 * 24 * 60 * 60;

/**
 * The most lines and bytes a grant may have: a longer one is refused.
 */
const maxLines = 64;
const maxBytes = 8192;

/**
 * Lines that only narrow. They are folded into the chain without the signing
 * key, so a holder can add them.
 */
const restrictions = new Set(["exp", "depth", "start", "tool"]);

/**
 * A grant as it travels: its lines and the chained signature.
 */
export interface WireGrant {
  lines: string[];
  sig: string;
}

/**
 * A report route a grant names.
 */
export interface GrantRoute {
  type: string;
  agent: string;
  thread: string;
  if?: string;
}

/**
 * A grant that verified, with its lines read.
 */
export interface Grant {
  /**
   * Every line, with the holder's `sub` written out.
   */
  lines: string[];
  sig: string;

  /**
   * The thread that holds the last block.
   */
  sub: string;
  iss?: string;
  iat?: number;

  /**
   * When the last block ends, in unix seconds, for an unattached child.
   */
  until?: number;

  /**
   * The earliest `exp` of the chain, in unix seconds.
   */
  exp?: number;

  /**
   * What the chain restricts: depth and the inherited discovery lists.
   */
  limits: EffectiveLimits;

  /**
   * The thread that started the holder: its agent's address and its key.
   */
  par?: { address: string; key: string };

  /**
   * The run of the parent, for an attached child.
   */
  run?: string;
  rep: GrantRoute[];
  lend?: string;
  grp?: string;
}

const link = (key: string, data: string): string => {
  // 128 bits, 32 hex characters.
  return fullMac(key, data).slice(0, 32);
};

const nameOf = (line: string): string => {
  const at = line.indexOf("=");

  return at < 0 ? line : line.slice(0, at);
};

const lineValue = (line: string): string => {
  return line.slice(line.indexOf("=") + 1);
};

/**
 * The tag after `line`, given the tag before it.
 */
const fold = (secret: string, before: string, line: string): string => {
  return restrictions.has(nameOf(line))
    ? link(before, line)
    : link(link(secret, "grant-line"), `${before}\n${line}`);
};

const start = (secret: string): string => {
  return link(secret, "grant-root");
};

const chain = (
  secret: string,
  lines: readonly string[],
  from: string = start(secret),
): string => {
  return lines.reduce((before, line) => {
    return fold(secret, before, line);
  }, from);
};

const json = <T>(text: string): T | undefined => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};

const seconds = (value: string): number | undefined => {
  return /^\d{1,13}$/.test(value) ? Number(value) : undefined;
};

/**
 * Reads the lines of a chain that verified.
 */
const parse = (lines: string[], sig: string): Grant | undefined => {
  let depth: number | undefined;
  let exp: number | undefined;
  const agents: unknown[] = [];
  const tools: unknown[] = [];
  let block: Pick<
    Grant,
    "sub" | "iss" | "iat" | "until" | "par" | "run" | "rep" | "lend" | "grp"
  > | null = null;

  for (const line of lines) {
    const name = nameOf(line);
    const value = lineValue(line);

    if (name === "depth") {
      // A line that does not read closes the limit.
      depth = Math.min(depth ?? Infinity, seconds(value) ?? 0);
    } else if (name === "exp") {
      exp = Math.min(exp ?? Infinity, seconds(value) ?? 0);
    } else if (name === "start") {
      agents.push(json(value) ?? null);
    } else if (name === "tool") {
      tools.push(json(value) ?? null);
    } else if (name === "sub") {
      block = { sub: value, rep: [] };
    } else if (block) {
      if (name === "iss") {
        block.iss = value;
      } else if (name === "iat") {
        block.iat = seconds(value);
      } else if (name === "until") {
        block.until = seconds(value) ?? 0;
      } else if (name === "par") {
        const given = json<unknown>(value);

        if (
          Array.isArray(given) &&
          typeof given[0] === "string" &&
          typeof given[1] === "string"
        ) {
          block.par = { address: given[0], key: given[1] };
        }
      } else if (name === "run") {
        block.run = value;
      } else if (name === "rep") {
        const given = json<unknown>(value);

        if (
          Array.isArray(given) &&
          typeof given[0] === "string" &&
          typeof given[1] === "string" &&
          typeof given[2] === "string"
        ) {
          block.rep.push({
            type: given[0],
            agent: given[1],
            thread: given[2],
            ...(typeof given[3] === "string" && { if: given[3] }),
          });
        }
      } else if (name === "lend") {
        block.lend = value;
      } else if (name === "grp") {
        block.grp = value;
      }
    }
  }

  if (!block) {
    return undefined;
  }

  const limits = readInheritedLimits({
    limits: {
      ...(depth !== undefined && { depth }),
      discovery: {
        ...(agents.length > 0 && { agents }),
        ...(tools.length > 0 && { tools }),
      },
    },
  }) as EffectiveLimits;

  return { lines, sig, ...block, ...(exp !== undefined && { exp }), limits };
};

/**
 * What a grant looks like on the wire: the holder's own `sub` line is left
 * out of the value, since the event names the thread.
 */
export const toWire = (grant: Grant): WireGrant => {
  const lines = [...grant.lines];
  const at = lines.map(nameOf).lastIndexOf("sub");

  if (at >= 0 && lines[at] === `sub=${grant.sub}`) {
    lines[at] = "sub";
  }

  return { lines, sig: grant.sig };
};

/**
 * A grant read from the wire, or `undefined` when it is malformed, was not
 * signed by this environment's key or does not name `holder` as its last
 * holder.
 * @param client The reading app's client, whose signing key (or fallback)
 * checks the chain.
 * @param wire What came with the message.
 * @param holder The thread the grant should be held by.
 */
export const verifyGrant = (
  client: SigningKeys,
  wire: unknown,
  holder: string,
): Grant | undefined => {
  const given = wire as { lines?: unknown; sig?: unknown } | null | undefined;

  if (
    typeof given !== "object" ||
    given === null ||
    !Array.isArray(given.lines) ||
    given.lines.length === 0 ||
    given.lines.length > maxLines ||
    typeof given.sig !== "string" ||
    !given.lines.every((line) => {
      return typeof line === "string";
    }) ||
    JSON.stringify(given.lines).length > maxBytes
  ) {
    return undefined;
  }

  const lines = (given.lines as string[]).map((line) => {
    return line === "sub" ? `sub=${holder}` : line;
  });

  if (
    !secretsOf(client).some((secret) => {
      return chain(secret, lines) === given.sig;
    })
  ) {
    return undefined;
  }

  const grant = parse(lines, given.sig);

  return grant?.sub === holder ? grant : undefined;
};

/**
 * What a new block of a grant is made of.
 */
export interface GrantBlock {
  /**
   * The grant of the thread that starts the holder, if it has one: the new
   * block follows it.
   */
  parent?: Grant;

  /**
   * The thread that holds the new block.
   */
  thread: string;

  /**
   * Restriction lines to add before the block: `depth=`, `start=`, `tool=`.
   */
  restrict?: string[];

  /**
   * The block's own lines, after `sub`: `iss=`, `iat=`, `par=` and so on.
   */
  lines: string[];
}

/**
 * Makes a grant for a thread: the starter's own grant, if it has one, with
 * the restrictions and one block for the new holder after it.
 * @param client The client, whose signing key signs the block.
 * @param block What to add.
 */
export const mintGrant = (client: SigningKeys, block: GrantBlock): Grant => {
  const [secret] = secretsOf(client) as [string];
  const before = block.parent?.lines ?? [];
  const lines = [
    ...before,
    ...(block.restrict ?? []),
    `sub=${block.thread}`,
    ...block.lines,
  ];

  if (lines.length > maxLines) {
    throw new Error(
      `This chain of agents has grown past what a grant can hold (${maxLines} lines).`,
    );
  }

  const sig = chain(
    secret,
    lines.slice(before.length),
    block.parent?.sig ?? start(secret),
  );
  const grant = parse(lines, sig);

  if (!grant) {
    throw new Error("A grant needs a holder");
  }

  return grant;
};

/**
 * The grant with restriction lines added: a copy that can do no more than the
 * original. It needs no key. Any other line is refused: only an app of the
 * environment can add those.
 * @param grant The grant.
 * @param extra The lines: `depth=`, `start=`, `tool=` or `exp=`.
 */
export const attenuate = (grant: Grant, extra: string[]): Grant => {
  for (const line of extra) {
    if (!restrictions.has(nameOf(line))) {
      throw new Error(`"${line}" is not a line that only narrows a grant`);
    }
  }

  const sig = extra.reduce((before, line) => {
    return link(before, line);
  }, grant.sig);
  const made = parse([...grant.lines, ...extra], sig);

  if (!made) {
    throw new Error("A grant needs a holder");
  }

  return made;
};

/**
 * The lines of a report route.
 */
export const routeLine = (route: GrantRoute): string => {
  return `rep=${JSON.stringify([route.type, route.agent, route.thread, ...(route.if === undefined ? [] : [route.if])])}`;
};

/**
 * The line of the starter.
 */
export const parentLine = (address: string, key: string): string => {
  return `par=${JSON.stringify([address, key])}`;
};

/**
 * A short digest of what a start lends, to put in the grant. A lend is
 * checked against it.
 * @param lent The lent machines.
 */
export const lendDigest = (lent: unknown): string => {
  return sha256()
    .update(JSON.stringify(sortKeys(lent)))
    .digest("hex")
    .slice(0, 24);
};

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => {
          return a < b ? -1 : a > b ? 1 : 0;
        })
        .map(([name, inner]) => {
          return [name, sortKeys(inner)];
        }),
    );
  }

  return value;
};

/**
 * The key of a discovery list, so a list the chain already has is not added
 * again.
 */
export const listKey = (list: readonly NormalizedDiscoveryEntry[]): string => {
  return JSON.stringify(
    list
      .map((entry) => {
        return JSON.stringify(entry);
      })
      .sort(),
  );
};

/**
 * The restriction lines that bring `inherited` (what the grant already says)
 * to `wanted`: the depth and the discovery lists that the grant does not
 * hold yet.
 * @param wanted What the holder's children are to inherit.
 * @param inherited The limits of the starter's own grant.
 */
export const restrictionLines = (
  wanted: EffectiveLimits,
  inherited?: EffectiveLimits,
): string[] => {
  const lines: string[] = [];

  if (wanted.depth !== undefined) {
    lines.push(`depth=${wanted.depth}`);
  }

  for (const [kind, name] of [
    ["agents", "start"],
    ["tools", "tool"],
  ] as const) {
    const held = new Set(
      (inherited?.discovery?.[kind] ?? []).map((list) => {
        return listKey(list);
      }),
    );

    for (const list of wanted.discovery?.[kind] ?? []) {
      if (!held.has(listKey(list))) {
        held.add(listKey(list));
        lines.push(`${name}=${JSON.stringify(list)}`);
      }
    }
  }

  return lines;
};

const popOf = (
  secret: string,
  sig: string,
  id: string,
  target: string,
): string => {
  return link(link(secret, `pop:${sig}`), JSON.stringify([id, target]));
};

/**
 * What a message carries beside its grant: a proof made for this event ID and
 * this target thread.
 * @param client The sender's client.
 * @param grant The grant the message relies on.
 * @param id The event's ID.
 * @param target The thread the event is for.
 * @param renew The renewal the holder was sent, if any.
 */
export const proofOf = (
  client: SigningKeys,
  grant: Grant,
  id: string,
  target: string,
  renew?: Renewal,
): { grant: WireGrant; pop: string; renew?: Renewal } => {
  const [secret] = secretsOf(client) as [string];

  return {
    grant: toWire(grant),
    pop: popOf(secret, grant.sig, id, target),
    ...(renew && { renew }),
  };
};

/**
 * Whether `pop` is the proof of a grant for this event and target.
 */
export const proofIsValid = (
  client: SigningKeys,
  grant: Grant,
  id: unknown,
  target: unknown,
  pop: unknown,
): boolean => {
  return (
    typeof id === "string" &&
    typeof target === "string" &&
    typeof pop === "string" &&
    secretsOf(client).some((secret) => {
      return popOf(secret, grant.sig, id, target) === pop;
    })
  );
};

/**
 * What a starter sends its unattached child to keep the grant alive: a new
 * end, made for that child and that starter.
 */
export interface Renewal {
  until: number;
  sig: string;
}

const renewalSig = (
  secret: string,
  child: string,
  starter: string,
  until: number,
): string => {
  return link(secret, `renew:${JSON.stringify([child, starter, until])}`);
};

/**
 * A renewal of the grant of `child`, from the thread `starter`.
 */
export const renewalFor = (
  client: SigningKeys,
  child: string,
  starter: string,
  until: number,
): Renewal => {
  const [secret] = secretsOf(client) as [string];

  return { until, sig: renewalSig(secret, child, starter, until) };
};

/**
 * The new end a message's renewal gives `grant`, or `undefined` when it is
 * not one: it must be made for this grant's holder by the thread that started
 * the holder, and be later than the grant's own end.
 * @param client The holder's client.
 * @param grant The holder's grant.
 * @param renewal What the message carried.
 * @param from The key of the thread that sent it.
 */
export const renewedUntil = (
  client: SigningKeys,
  grant: Grant,
  renewal: unknown,
  from: unknown,
): number | undefined => {
  const given = renewal as Partial<Renewal> | null | undefined;

  if (
    grant.until === undefined ||
    grant.par === undefined ||
    typeof from !== "string" ||
    from !== grant.par.key ||
    typeof given !== "object" ||
    given === null ||
    typeof given.until !== "number" ||
    !Number.isFinite(given.until) ||
    typeof given.sig !== "string" ||
    given.until <= grant.until
  ) {
    return undefined;
  }

  const { until, sig } = given as Renewal;

  return secretsOf(client).some((secret) => {
    return renewalSig(secret, grant.sub, from, until) === sig;
  })
    ? until
    : undefined;
};

/**
 * Whether a grant has ended by `at` (milliseconds): its earliest `exp`, or
 * the end of its last block (`renewed` replaces it with a later one). With no
 * time to compare, nothing has ended.
 */
export const grantEnded = (
  grant: Grant,
  at: number | undefined,
  renewed?: number,
): boolean => {
  if (at === undefined || !Number.isFinite(at)) {
    return false;
  }

  const ends = [
    grant.exp,
    grant.until === undefined ? undefined : Math.max(grant.until, renewed ?? 0),
  ].filter((end): end is number => {
    return end !== undefined;
  });

  return ends.some((end) => {
    return at >= end * 1000;
  });
};

/**
 * Why a message that carries a grant is refused, or `undefined` when it
 * carries none or its grant checks out: signed by this environment's key, held
 * by the thread that sent it, with a proof made for this event and thread,
 * and not ended.
 * @param client The receiving app's client.
 * @param event The message: its ID, time and data.
 * @param thread The thread it is for.
 */
export const messageGrantProblem = (
  client: SigningKeys,
  event: { id?: string; ts?: number; data?: unknown },
  thread: string,
): string | undefined => {
  const data = event.data as
    | { from?: { key?: unknown }; "::agents"?: GrantData }
    | undefined;
  const carried = data?.["::agents"];

  if (carried?.grant === undefined) {
    return undefined;
  }

  const key = data?.from?.key;
  const grant =
    typeof key === "string"
      ? verifyGrant(client, carried.grant, key)
      : undefined;

  if (!grant) {
    return "its grant does not verify: it was altered, signed with another key, or is held by another thread";
  }

  if (!proofIsValid(client, grant, event.id, thread, carried.pop)) {
    return "its grant does not belong to this message: the proof does not match the event and thread";
  }

  if (
    grantEnded(
      grant,
      event.ts,
      renewedUntil(client, grant, carried.renew, grant.par?.key),
    )
  ) {
    return "its grant has expired";
  }

  return undefined;
};

/**
 * The grant a run's start carries, checked, or `undefined` for a message that
 * carries none. It throws an error the run fails with for good for a start
 * that is forged: one that claims to have been started by an agent with no
 * grant, carries a grant that does not verify or is not made for this thread,
 * message and time.
 * @param client The agent's client.
 * @param event The event that started the run.
 * @param thread The run's thread key.
 */
export const startGrantOf = (
  client: Inngest.Any,
  event: { id?: string; name?: string; ts?: number; data?: unknown },
  thread: string,
): Grant | undefined => {
  const recovered = event.name === "agent/recover";
  const inner = recovered
    ? (
        event.data as
          | { event?: { id?: string; name?: string; data?: unknown } }
          | undefined
      )?.event
    : event;

  // Only a message or a question carries what a start or a message relies on.
  if (inner?.name !== "agent/message" && inner?.name !== "agent/question") {
    return undefined;
  }

  const data = inner?.data as
    | { from?: Record<string, unknown>; "::agents"?: GrantData }
    | undefined;
  const carried = data?.["::agents"];
  const from = data?.from;
  const isStart = from?.thread === thread;

  if (carried?.grant === undefined) {
    if (
      from &&
      ["thread", "limits", "reports", "reports_sig", "lent", "lent_sig"].some(
        (field) => {
          return from[field] !== undefined;
        },
      )
    ) {
      throw new NonRetriableError(
        "This start says it was started by an agent but carries no grant, so it is refused: limits, reports and lends are only taken from a signed grant",
      );
    }

    return undefined;
  }

  // A message that carries its sender's grant, not a start.
  if (!isStart) {
    const problem = messageGrantProblem(
      client,
      { id: inner?.id, ts: event.ts, data: inner?.data },
      thread,
    );

    if (problem) {
      throw new NonRetriableError(`This message is refused: ${problem}`);
    }

    return undefined;
  }

  const grant = verifyGrant(client, carried.grant, thread);

  if (!grant) {
    throw new NonRetriableError(
      "This start carries a grant that does not verify: it was altered, signed with another key, or made for another thread",
    );
  }

  if (!proofIsValid(client, grant, inner?.id, thread, carried.pop)) {
    throw new NonRetriableError(
      "This start's grant does not belong to this message: its proof does not match the event and thread",
    );
  }

  if (grantEnded(grant, event.ts)) {
    throw new NonRetriableError("This start's grant has expired");
  }

  return grant;
};

/**
 * The grant each running execution holds, set when its start was checked.
 */
const held = new WeakMap<object, Grant>();

/**
 * Notes the grant an execution runs with.
 * @param instance The execution (`getAsyncCtxSync().execution.instance`).
 * @param grant Its verified grant.
 */
export const registerGrant = (instance: object, grant: Grant): void => {
  held.set(instance, grant);
};

/**
 * The grant an execution runs with, if its start carried one.
 * @param instance The execution.
 */
export const grantOfExecution = (instance: object): Grant | undefined => {
  return held.get(instance);
};

/**
 * The renewal that moved a live run's grant: the run's own copy of the end.
 */
const renewals = new WeakMap<object, Renewal>();

/**
 * Notes a renewal of the grant of an execution. The latest end is kept.
 */
export const noteRenewal = (instance: object, renewal: Renewal): void => {
  const kept = renewals.get(instance);

  if (!kept || renewal.until > kept.until) {
    renewals.set(instance, renewal);
  }
};

/**
 * The renewal an execution's grant was given, if one came.
 */
export const renewalOfExecution = (instance: object): Renewal | undefined => {
  return renewals.get(instance);
};

/**
 * The keys of the threads an execution started, so it can renew their grants
 * when it messages them even when the key carries no tag.
 */
const startedKeys = new WeakMap<object, Set<string>>();

/**
 * Notes a thread an execution started.
 */
export const noteStarted = (instance: object, key: string): void => {
  const keys = startedKeys.get(instance) ?? new Set();

  keys.add(key);
  startedKeys.set(instance, keys);
};

/**
 * Whether an execution started the thread.
 */
export const hasStarted = (instance: object, key: string): boolean => {
  return startedKeys.get(instance)?.has(key) === true;
};
