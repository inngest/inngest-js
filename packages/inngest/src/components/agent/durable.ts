/**
 * @module
 * SPIKE: `durable(step)` makes a Vercel AI SDK (`ai@7`) loop durable. The loop
 * itself is the AI SDK's, running unmodified in the function body. Every model
 * call is one step and every tool `execute` is one step keyed by `toolCallId`.
 *
 * No runtime dependency on `ai`: the wrapped model is a plain language model
 * object (spec "v4") and the tools are plain `{ description, inputSchema,
 * execute }` objects.
 */
import { step as globalStep, withSpan, withStepIdPrefix } from "../InngestStepTools.ts";
import {
  resolveToolCall,
  type SandboxTool,
  type SandboxTools,
} from "../sandbox/tools.ts";
import { modelError } from "./modelErrors.ts";

type Step = typeof globalStep;

// ---------------------------------------------------------------- serde

const bytesKey = "~bytes";
const dateKey = "~date";

/**
 * Makes a doGenerate result / stream part JSON safe: Date and Uint8Array are
 * tagged, `undefined` is dropped by JSON itself, request and response bodies
 * are dropped (they can be megabytes and are not needed to replay).
 */
export const toJson = (value: unknown): unknown => {
  return JSON.parse(
    JSON.stringify(value, function (this: unknown, key, current) {
      if (key === "body" && (this as { headers?: unknown }).headers !== undefined) {
        return undefined;
      }

      const raw = (this as Record<string, unknown>)[key];

      if (raw instanceof Date) {
        return { [dateKey]: raw.toISOString() };
      }

      if (raw instanceof Uint8Array) {
        return { [bytesKey]: Buffer.from(raw).toString("base64") };
      }

      if (raw instanceof Error) {
        return { "~error": { name: raw.name, message: raw.message } };
      }

      return current;
    }),
  );
};

export const fromJson = <T>(value: unknown): T => {
  return JSON.parse(JSON.stringify(value), (_key, current) => {
    if (current && typeof current === "object") {
      if (dateKey in current) {
        return new Date((current as Record<string, string>)[dateKey] as string);
      }

      if (bytesKey in current) {
        return new Uint8Array(
          Buffer.from((current as Record<string, string>)[bytesKey] as string, "base64"),
        );
      }
    }

    return current;
  }) as T;
};

// ---------------------------------------------------------------- model

type AnyModel = {
  specificationVersion: string;
  provider: string;
  modelId: string;
  supportedUrls: unknown;
  doGenerate: (params: any) => Promise<any>;
  doStream: (params: any) => Promise<any>;
};

const randomId = (): string => {
  return `resp_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
};

const drain = async (stream: ReadableStream<unknown>): Promise<unknown[]> => {
  const parts: unknown[] = [];
  const reader = stream.getReader();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return parts;
    }
    parts.push(value);
  }
};

const replay = (parts: unknown[]): ReadableStream<unknown> => {
  return new ReadableStream({
    start: (controller) => {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
};

/**
 * The AI SDK's `APICallError` carries `statusCode` and `responseHeaders`,
 * where `modelError()` reads `status` and `headers` (the vendor SDK shape).
 */
const aiSdkError = (error: unknown): unknown => {
  const { statusCode, responseHeaders } = (error ?? {}) as {
    statusCode?: number;
    responseHeaders?: Record<string, string>;
  };

  if (typeof statusCode !== "number") {
    return modelError(error);
  }

  const shaped = Object.assign(Object.create(error as object), {
    status: statusCode,
    headers: responseHeaders,
  });

  const mapped = modelError(shaped);

  return mapped === shaped ? error : mapped;
};

export interface DurableOptions {
  /**
   * Prefix for every step ID. Give each concurrent loop (sub-agent) its own.
   * Default `ai`.
   */
  id?: string;

  /**
   * Run model calls with `step.ai.wrap` instead of `step.run`.
   */
  aiWrap?: boolean;

  /**
   * Fill a missing response id and timestamp inside the step. Default true.
   */
  fillMetadata?: boolean;

  /**
   * Tool results longer than this many characters of JSON are replaced with a
   * short preview, because a step output over the platform limit fails the run.
   */
  maxToolOutput?: number;
}

// ---------------------------------------------------------------- tools

const isSandboxTool = (value: unknown): value is SandboxTool => {
  return (
    typeof value === "object" &&
    value !== null &&
    "run" in value &&
    !("execute" in value)
  );
};

const lastOf = async (value: unknown): Promise<unknown> => {
  if (
    value &&
    typeof value === "object" &&
    Symbol.asyncIterator in (value as object)
  ) {
    let last: unknown;
    for await (const chunk of value as AsyncIterable<unknown>) {
      last = chunk;
    }
    return last;
  }

  return value;
};

const asStandardSchema = (schema: unknown): unknown => {
  if (schema && typeof schema === "object" && "~standard" in schema) {
    return schema;
  }

  const json = schema ?? { type: "object" };

  return {
    "~standard": {
      version: 1,
      vendor: "inngest",
      validate: (value: unknown) => {
        return { value };
      },
      jsonSchema: { input: () => json, output: () => json },
    },
  };
};

// ---------------------------------------------------------------- prepareStep

export interface PrepareStepHelpers {
  /**
   * Called before every model call after the first. Return text to append as
   * user messages. Runs in your function on every replay, so read durable
   * state with a step inside it.
   */
  steer?: (turn: number) => Promise<string[] | string | undefined | void>;

  /**
   * On the last allowed step, tools are switched off and this message is
   * appended. Needs `maxSteps`.
   */
  wrapUp?: string;
  maxSteps?: number;

  /**
   * Drop the oldest messages once the history is longer than this.
   */
  clip?: { maxChars: number };
}

const size = (messages: unknown[]): number => {
  return JSON.stringify(messages).length;
};

const clipMessages = (messages: any[], maxChars: number): any[] => {
  if (size(messages) <= maxChars || messages.length <= 2) {
    return messages;
  }

  const [first, ...rest] = messages;

  while (rest.length > 1 && size([first, ...rest]) > maxChars) {
    rest.shift();

    // Never start on a tool result or an assistant turn whose results were cut.
    while (rest.length > 1 && rest[0].role !== "user") {
      rest.shift();
    }
  }

  return [first, ...rest];
};

// ---------------------------------------------------------------- durable

export const durable = (step: Step, options: DurableOptions = {}) => {
  const {
    id = "ai",
    aiWrap = false,
    fillMetadata = true,
    maxToolOutput = 1_000_000,
  } = options;

  const run = <T>(
    stepId: string,
    fn: (input?: any) => Promise<T>,
    input?: unknown,
  ): Promise<T> => {
    if (aiWrap && input !== undefined) {
      return (step.ai.wrap as any)(stepId, fn, input) as Promise<T>;
    }

    return (step.run as any)(stepId, () => fn()) as Promise<T>;
  };

  const model = <M extends object>(languageModel: M): M => {
    const inner = languageModel as unknown as AnyModel;
    let call = 0;

    const generate = async (params: any): Promise<any> => {
      call += 1;
      const stepId = `${id}:model:${call}`;

      const input = toJson({ ...params, abortSignal: undefined });

      const reply = await run(stepId, async (wrapped?: unknown) => {
        try {
          const result = await inner.doGenerate({
            ...(wrapped ? fromJson<object>(wrapped) : params),
            abortSignal: undefined,
          });

          return toJson({
            ...result,
            ...(fillMetadata && {
              response: {
                ...result.response,
                id: result.response?.id ?? randomId(),
                timestamp: result.response?.timestamp ?? new Date(),
                modelId: result.response?.modelId ?? inner.modelId,
              },
            }),
          });
        } catch (error) {
          throw aiSdkError(error);
        }
      }, input);

      return fromJson(reply);
    };

    const stream = async (params: any): Promise<any> => {
      call += 1;
      const stepId = `${id}:model:${call}`;

      const parts = await run(stepId, async () => {
        try {
          const result = await inner.doStream({
            ...params,
            abortSignal: undefined,
          });

          return toJson(await drain(result.stream));
        } catch (error) {
          throw aiSdkError(error);
        }
      });

      return { stream: replay(fromJson(parts)) };
    };

    return {
      specificationVersion: inner.specificationVersion,
      provider: inner.provider,
      modelId: inner.modelId,
      get supportedUrls() {
        return inner.supportedUrls;
      },
      doGenerate: generate,
      doStream: stream,
    } as unknown as M;
  };

  const tools = <T extends Record<string, unknown>>(
    definitions: T,
  ): Record<keyof T, any> => {
    return Object.fromEntries(
      Object.entries(definitions).map(([name, definition]) => {
        if (isSandboxTool(definition)) {
          return [name, sandboxTool(name, definition)];
        }

        const original = definition as {
          execute?: (input: unknown, options: { toolCallId: string }) => unknown;
        };

        if (!original.execute) {
          return [name, definition];
        }

        return [
          name,
          {
            ...original,
            execute: (input: unknown, opts: { toolCallId: string }) => {
              return run(`${id}:tool:${name}:${opts.toolCallId}`, async () => {
                const value =
                  (await lastOf(original.execute?.(input, opts))) ?? null;

                // A step output over ~4 MB fails the run and re-runs the tool.
                const text = JSON.stringify(value);

                if (text.length > maxToolOutput) {
                  return {
                    "~truncated": true,
                    bytes: text.length,
                    preview: text.slice(0, 2_000),
                  };
                }

                return value;
              });
            },
          },
        ];
      }),
    ) as Record<keyof T, any>;
  };

  const sandboxTool = (name: string, definition: SandboxTool) => {
    return {
      description: definition.description,
      inputSchema: asStandardSchema(definition.input),
      execute: async (input: unknown, opts: { toolCallId: string }) => {
        const entries: SandboxTools = { [name]: definition };
        const resolved = await resolveToolCall(
          entries,
          {
            op: "call",
            id: 0,
            tool: name,
            args: [],
            kwargs: (input ?? {}) as Record<string, unknown>,
          },
          JSON.stringify(input ?? {}),
        );

        if (resolved.error !== undefined) {
          throw new Error(resolved.error);
        }

        const stepId = `${id}:tool:${name}:${opts.toolCallId}`;
        const context = {
          signal: new AbortController().signal,
          idempotencyKey: opts.toolCallId,
        };

        if (resolved.group) {
          const span = { id: stepId, name: resolved.displayName ?? name, kind: "tool" };

          return withSpan(span as never, () => {
            return withStepIdPrefix(`${stepId}:`, () => {
              return resolved.invoke(context);
            });
          });
        }

        return step.run(stepId, () => {
          return resolved.invoke(context);
        });
      },
    };
  };

  const prepareStep = (helpers: PrepareStepHelpers) => {
    return async ({
      stepNumber,
      messages,
    }: {
      stepNumber: number;
      messages: any[];
    }) => {
      const result: { messages?: any[]; toolChoice?: "none" } = {};
      let next = messages;

      if (helpers.steer && stepNumber > 0) {
        const steered = await helpers.steer(stepNumber);
        const texts =
          steered === undefined || steered === null
            ? []
            : Array.isArray(steered)
              ? steered
              : [steered];

        if (texts.length) {
          next = [
            ...next,
            ...texts.map((text) => ({ role: "user", content: text })),
          ];
        }
      }

      if (helpers.clip) {
        next = clipMessages(next, helpers.clip.maxChars);
      }

      if (
        helpers.wrapUp &&
        helpers.maxSteps !== undefined &&
        stepNumber === helpers.maxSteps - 1
      ) {
        next = [...next, { role: "user", content: helpers.wrapUp }];
        result.toolChoice = "none";
      }

      if (next !== messages) {
        result.messages = next;
      }

      return result;
    };
  };

  return { model, tools, prepareStep };
};
