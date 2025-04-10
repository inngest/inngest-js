/* eslint-disable @typescript-eslint/no-unused-vars */
import { Inngest } from "inngest";
import * as v from "valibot";
import { channel, typeOnlyChannel } from "./channel";
import { getSubscriptionToken, subscribe } from "./subscribe";
import { topic } from "./topic";
import { type Realtime } from "./types";

/**
 * assert the subject satisfies the specified type T
 * @type T the type to check against.
 */
export function assertType<T>(subject: T): asserts subject is T {}

/**
 * Returns `true` if the given generic `T` is `any`, or `false` if it is not.
 */
export type IsAny<T> = 0 extends 1 & T ? true : false;

/**
Returns a boolean for whether the two given types are equal.

{@link https://github.com/microsoft/TypeScript/issues/27024#issuecomment-421529650}
{@link https://stackoverflow.com/questions/68961864/how-does-the-equals-work-in-typescript/68963796#68963796}

Use-cases:
- If you want to make a conditional branch based on the result of a comparison of two types.

@example
```
import type {IsEqual} from 'type-fest';

// This type returns a boolean for whether the given array includes the given item.
// `IsEqual` is used to compare the given array at position 0 and the given item and then return true if they are equal.
type Includes<Value extends readonly any[], Item> =
	Value extends readonly [Value[0], ...infer rest]
		? IsEqual<Value[0], Item> extends true
			? true
			: Includes<rest, Item>
		: false;
```
*/
export type IsEqual<A, B> = (<G>() => G extends A ? 1 : 2) extends <
  G,
>() => G extends B ? 1 : 2
  ? true
  : false;

describe("subscribe", () => {
  const app = new Inngest({ id: "test" });

  describe("types", () => {
    const createdTopic = topic("created").schema(
      v.object({
        id: v.string(),
        name: v.string(),
      }),
    );

    const updatedTopic = topic("updated").type<boolean>();

    const unusedTopic = topic("unused").type<number>();

    const staticChannel = channel("static")
      .addTopic(createdTopic)
      .addTopic(updatedTopic)
      .addTopic(unusedTopic);

    const userChannel = channel((userId: string) => `user/${userId}`)
      .addTopic(createdTopic)
      .addTopic(updatedTopic)
      .addTopic(unusedTopic);

    describe("channels and topics", () => {
      describe("topic", () => {
        test("can create a blank topic", () => {
          const t = topic("test");

          expect(t).toBeDefined();
          assertType<Realtime.Topic.Definition>(t);

          expect(t.name).toBe("test");
          assertType<"test">(t.name);

          expect(t.getSchema()).toBeUndefined();

          assertType<IsAny<Realtime.Topic.InferPublish<typeof t>>>(true);
          assertType<IsAny<Realtime.Topic.InferSubscribe<typeof t>>>(true);
        });

        test("topic ID must be a string", () => {
          const _fn = () => {
            // @ts-expect-error Topic ID must be a string
            topic(1);

            // @ts-expect-error Topic ID must be a string
            topic({ foo: "bar" });

            // @ts-expect-error Topic ID must be a string
            topic(undefined);

            // @ts-expect-error Topic ID must be a string
            topic();

            // @ts-expect-error Topic ID must be a string
            topic(null);

            // @ts-expect-error Topic ID must be a string
            topic(true);

            // @ts-expect-error Topic ID must be a string
            topic(false);
          };
        });

        test("can type a topic", () => {
          const t = topic("test").type<string>();

          expect(t).toBeDefined();
          assertType<Realtime.Topic.Definition>(t);

          expect(t.name).toBe("test");
          assertType<"test">(t.name);

          expect(t.getSchema()).toBeUndefined();

          assertType<IsEqual<string, Realtime.Topic.InferPublish<typeof t>>>(
            true,
          );
          assertType<IsEqual<string, Realtime.Topic.InferSubscribe<typeof t>>>(
            true,
          );
        });

        test("can overwrite a topic's type", () => {
          const t = topic("test").type<string>().type<number>();

          expect(t).toBeDefined();
          assertType<Realtime.Topic.Definition>(t);

          expect(t.name).toBe("test");
          assertType<"test">(t.name);

          expect(t.getSchema()).toBeUndefined();

          assertType<IsEqual<number, Realtime.Topic.InferPublish<typeof t>>>(
            true,
          );
          assertType<IsEqual<number, Realtime.Topic.InferSubscribe<typeof t>>>(
            true,
          );
        });

        test("can add a schema to a topic", () => {
          const t = topic("test").schema(v.string());

          expect(t).toBeDefined();
          assertType<Realtime.Topic.Definition>(t);

          expect(t.name).toBe("test");
          assertType<"test">(t.name);

          expect(t.getSchema()).toBeDefined();

          assertType<IsEqual<string, Realtime.Topic.InferPublish<typeof t>>>(
            true,
          );
          assertType<IsEqual<string, Realtime.Topic.InferSubscribe<typeof t>>>(
            true,
          );
        });

        test("schema must be a valid schema", () => {
          const _fn = () => {
            // @ts-expect-error Invalid schema
            topic("test").schema({ foo: "bar" });

            // @ts-expect-error Invalid schema
            topic("test").schema(undefined);

            // @ts-expect-error Invalid schema
            topic("test").schema();

            // @ts-expect-error Invalid schema
            topic("test").schema(null);

            // @ts-expect-error Invalid schema
            topic("test").schema(true);

            // @ts-expect-error Invalid schema
            topic("test").schema(false);
          };
        });
      });

      describe("channel", () => {
        test("can create a blank channel", () => {
          const c = channel("test");

          expect(c).toBeDefined();
          expect(c).toBeInstanceOf(Function);
          assertType<Realtime.Channel.Definition>(c);
        });

        test("running a static channel definition gets a channel", () => {
          const c = staticChannel();

          expect(c).toBeDefined();
          assertType<Realtime.Channel>(c);

          expect(c.name).toBe("static");

          expect(c.created).toBeDefined();
          assertType<Realtime.Topic>(c.created);

          expect(c.updated).toBeDefined();
          assertType<Realtime.Topic>(c.updated);
        });

        test("running a dynamic channel definition gets a channel", () => {
          const c = userChannel("123");

          expect(c).toBeDefined();
          assertType<Realtime.Channel>(c);

          expect(c.name).toBe("user/123");

          expect(c.created).toBeDefined();
          assertType<Realtime.Topic>(c.created);

          expect(c.updated).toBeDefined();
          assertType<Realtime.Topic>(c.updated);
        });

        test("channel ID must be a string or a builder", () => {
          const _fn = () => {
            // @ts-expect-error Channel ID must be a string
            channel(1);

            // @ts-expect-error Channel ID must be a string
            channel({ foo: "bar" });

            // @ts-expect-error Channel ID must be a string
            channel(undefined);

            // @ts-expect-error Channel ID must be a string
            channel();

            // @ts-expect-error Channel ID must be a string
            channel(null);

            // @ts-expect-error Channel ID must be a string
            channel(true);

            // @ts-expect-error Channel ID must be a string
            channel(false);
          };
        });

        test("can create a blank dynamic channel", () => {
          const c = channel((userId: string) => `user/${userId}`);

          expect(c).toBeDefined();
          expect(c).toBeInstanceOf(Function);
          assertType<Realtime.Channel.Definition>(c);
        });

        test("can add a topic to a channel", () => {
          const c = channel("test").addTopic(createdTopic);

          expect(c).toBeDefined();
          assertType<Realtime.Channel.Definition>(c);

          expect(c().created).toBeDefined();
          assertType<Realtime.Topic>(c().created);
        });

        test("can add multiple topics to a channel", () => {
          const c = channel("test")
            .addTopic(createdTopic)
            .addTopic(updatedTopic);

          expect(c).toBeDefined();
          assertType<Realtime.Channel.Definition>(c);

          expect(c().created).toBeDefined();
          assertType<Realtime.Topic>(c().created);

          expect(c().updated).toBeDefined();
          assertType<Realtime.Topic>(c().updated);
        });

        test("can create a static channel using the types of another channel", () => {
          const c = typeOnlyChannel<typeof staticChannel>("static");

          expect(c).toBeDefined();
          assertType<Realtime.Channel>(c);

          expect(c.topics.created).toBeDefined();
          assertType<Realtime.Topic.Definition>(c.topics.created);

          expect(c.topics.updated).toBeDefined();
          assertType<Realtime.Topic.Definition>(c.topics.updated);

          expect(c.created).toBeDefined();
          assertType<Realtime.Topic>(c.created);

          expect(c.updated).toBeDefined();
          assertType<Realtime.Topic>(c.updated);
        });

        test("static channel ID must be correct if using the types of another channel", () => {
          const _fn = () => {
            // @ts-expect-error Incorrect channel
            typeOnlyChannel<typeof staticChannel>("staatic");
          };
        });

        test("can create a dynamic channel using the types of another channel", () => {
          const c = typeOnlyChannel<typeof userChannel>("user/123");

          expect(c).toBeDefined();
          assertType<Realtime.Channel>(c);

          expect(c.created).toBeDefined();
          assertType<Realtime.Topic>(c.created);

          expect(c.updated).toBeDefined();
          assertType<Realtime.Topic>(c.updated);
        });

        test("dynamic channel ID must be correct if using the types of another channel", () => {
          const _fn = () => {
            // @ts-expect-error Incorrect channel
            typeOnlyChannel<typeof userChannel>("foo");
          };
        });
      });
    });

    describe("strings only", () => {
      test("can subscribe with just strings", () => {
        const _fn = async () => {
          const stream = await subscribe(
            {
              channel: "test",
              topics: ["foo", "bar"],
            },
            (message) => {
              assertType<"test">(message.channel);
              assertType<"foo" | "bar">(message.topic);

              if (message.topic === "foo") {
                assertType<IsAny<typeof message.data>>(true);
              } else {
                assertType<IsAny<typeof message.data>>(true);
              }
            },
          );

          for await (const message of stream) {
            assertType<"test">(message.channel);
            assertType<"foo" | "bar">(message.topic);

            if (message.topic === "foo") {
              assertType<IsAny<typeof message.data>>(true);
            } else {
              assertType<IsAny<typeof message.data>>(true);
            }
          }

          const reader = stream.getReader();
          const { value: message, done } = await reader.read();
          if (!done) {
            assertType<"test">(message.channel);
            assertType<"foo" | "bar">(message.topic);

            if (message.topic === "foo") {
              assertType<IsAny<typeof message.data>>(true);
            } else {
              assertType<IsAny<typeof message.data>>(true);
            }
          }
        };
      });
    });

    describe("type-only channel import", () => {
      test("errors if channel name is incorrect", () => {
        const _fn = () => {
          void subscribe({
            // @ts-expect-error Incorrect channel
            channel: typeOnlyChannel<typeof userChannel>("test"),
            topics: ["created", "updated"],
          });
        };
      });

      test("errors if topic names are incorrect with static channel", () => {
        const _fn = () => {
          void subscribe({
            channel: typeOnlyChannel<typeof staticChannel>("static"),
            // @ts-expect-error Incorrect topic
            topics: ["created", "updated", "test"],
          });
        };
      });

      test("errors if topic names are incorrect with dynamic channel", () => {
        const _fn = () => {
          void subscribe({
            channel: typeOnlyChannel<typeof userChannel>("user/123"),
            // @ts-expect-error Incorrect topic
            topics: ["created", "updated", "test"],
          });
        };
      });

      test("can subscribe using types only of a static channel", () => {
        const _fn = async () => {
          const stream = await subscribe(
            {
              channel: typeOnlyChannel<typeof staticChannel>("static"),
              topics: ["created", "updated"],
            },
            (message) => {
              assertType<"static">(message.channel);
              assertType<"created" | "updated">(message.topic);

              if (message.topic === "created") {
                assertType<{ id: string; name: string }>(message.data);
              } else {
                assertType<boolean>(message.data);
              }
            },
          );

          for await (const message of stream) {
            assertType<"static">(message.channel);
            assertType<"created" | "updated">(message.topic);

            if (message.topic === "created") {
              assertType<{ id: string; name: string }>(message.data);
            } else {
              assertType<boolean>(message.data);
            }
          }

          const reader = stream.getReader();
          const { value: message, done } = await reader.read();
          if (!done) {
            assertType<"static">(message.channel);
            assertType<"created" | "updated">(message.topic);

            if (message.topic === "created") {
              assertType<{ id: string; name: string }>(message.data);
            } else {
              assertType<boolean>(message.data);
            }
          }
        };
      });

      test("can subscribe using types only of a dynamic channel", () => {
        const _fn = async () => {
          const stream = await subscribe(
            {
              channel: typeOnlyChannel<typeof userChannel>("user/123"),
              topics: ["created", "updated"],
            },
            (message) => {
              assertType<`user/${string}`>(message.channel);
              assertType<"created" | "updated">(message.topic);

              if (message.topic === "created") {
                assertType<{ id: string; name: string }>(message.data);
              } else {
                assertType<boolean>(message.data);
              }
            },
          );

          for await (const message of stream) {
            assertType<`user/${string}`>(message.channel);
            assertType<"created" | "updated">(message.topic);

            if (message.topic === "created") {
              assertType<{ id: string; name: string }>(message.data);
            } else {
              assertType<boolean>(message.data);
            }
          }

          const reader = stream.getReader();
          const { value: message, done } = await reader.read();
          if (!done) {
            assertType<`user/${string}`>(message.channel);
            assertType<"created" | "updated">(message.topic);

            if (message.topic === "created") {
              assertType<{ id: string; name: string }>(message.data);
            } else {
              assertType<boolean>(message.data);
            }
          }
        };
      });
    });

    describe("runtime channel import", () => {
      test("errors if static definition given", () => {
        const _fn = () => {
          void subscribe({
            // @ts-expect-error Definition given
            channel: staticChannel,
            topics: ["created", "updated"],
          });
        };
      });

      test("errors if dynamic definition given", () => {
        const _fn = () => {
          void subscribe({
            // @ts-expect-error Definition given
            channel: userChannel,
            topics: ["created", "updated"],
          });
        };
      });

      test("errors if topic names are incorrect with static channel", () => {
        const _fn = () => {
          void subscribe({
            channel: staticChannel(),
            // @ts-expect-error Incorrect topic
            topics: ["created", "updated", "test"],
          });
        };
      });

      test("errors if topic names are incorrect with dynamic channel", () => {
        const _fn = () => {
          void subscribe({
            channel: userChannel("123"),
            // @ts-expect-error Incorrect topic
            topics: ["created", "updated", "test"],
          });
        };
      });

      test("can subscribe with runtime import of a static channel", () => {
        const _fn = async () => {
          const stream = await subscribe({
            channel: staticChannel(),
            topics: ["created", "updated"],
          });

          for await (const message of stream) {
            assertType<"static">(message.channel);
            assertType<"created" | "updated">(message.topic);

            if (message.topic === "created") {
              assertType<{ id: string; name: string }>(message.data);
            } else {
              assertType<boolean>(message.data);
            }
          }

          const reader = stream.getReader();
          const { value: message, done } = await reader.read();
          if (!done) {
            assertType<"static">(message.channel);
            assertType<"created" | "updated">(message.topic);

            if (message.topic === "created") {
              assertType<{ id: string; name: string }>(message.data);
            } else {
              assertType<boolean>(message.data);
            }
          }
        };
      });

      test("can subscribe with runtime import of a dynamic channel", () => {
        const _fn = async () => {
          const stream = await subscribe({
            channel: userChannel("123"),
            topics: ["created", "updated"],
          });

          for await (const message of stream) {
            assertType<`user/${string}`>(message.channel);
            assertType<"created" | "updated">(message.topic);

            if (message.topic === "created") {
              assertType<{ id: string; name: string }>(message.data);
            } else {
              assertType<boolean>(message.data);
            }
          }

          const reader = stream.getReader();
          const { value: message, done } = await reader.read();
          if (!done) {
            assertType<`user/${string}`>(message.channel);
            assertType<"created" | "updated">(message.topic);

            if (message.topic === "created") {
              assertType<{ id: string; name: string }>(message.data);
            } else {
              assertType<boolean>(message.data);
            }
          }
        };
      });
    });

    describe("tokens", () => {
      test("can subscribe with a string-only token", () => {
        const _fn = async () => {
          const token = await getSubscriptionToken(app, {
            channel: "test",
            topics: ["foo", "bar"],
          });

          const stream = await subscribe(token, (message) => {
            assertType<"test">(message.channel);
            assertType<"foo" | "bar">(message.topic);

            if (message.topic === "foo") {
              assertType<IsAny<typeof message.data>>(true);
            } else {
              assertType<IsAny<typeof message.data>>(true);
            }
          });

          for await (const message of stream) {
            assertType<"test">(message.channel);
            assertType<"foo" | "bar">(message.topic);

            if (message.topic === "foo") {
              assertType<IsAny<typeof message.data>>(true);
            } else {
              assertType<IsAny<typeof message.data>>(true);
            }
          }

          const reader = stream.getReader();
          const { value: message, done } = await reader.read();
          if (!done) {
            assertType<"test">(message.channel);
            assertType<"foo" | "bar">(message.topic);

            if (message.topic === "foo") {
              assertType<IsAny<typeof message.data>>(true);
            } else {
              assertType<IsAny<typeof message.data>>(true);
            }
          }
        };
      });

      test("can subscribe with a type-only import static typed token", () => {
        const _fn = async () => {
          const token = await getSubscriptionToken(app, {
            channel: typeOnlyChannel<typeof staticChannel>("static"),
            topics: ["created", "updated"],
          });

          const stream = await subscribe(token, (message) => {
            assertType<"static">(message.channel);
            assertType<"created" | "updated">(message.topic);

            if (message.topic === "created") {
              assertType<{ id: string; name: string }>(message.data);
            } else {
              assertType<boolean>(message.data);
            }
          });

          for await (const message of stream) {
            assertType<"static">(message.channel);
            assertType<"created" | "updated">(message.topic);

            if (message.topic === "created") {
              assertType<{ id: string; name: string }>(message.data);
            } else {
              assertType<boolean>(message.data);
            }
          }

          const reader = stream.getReader();
          const { value: message, done } = await reader.read();
          if (!done) {
            assertType<"static">(message.channel);
            assertType<"created" | "updated">(message.topic);

            if (message.topic === "created") {
              assertType<{ id: string; name: string }>(message.data);
            } else {
              assertType<boolean>(message.data);
            }
          }
        };
      });

      test("can subscribe with a runtime import static typed token", () => {
        const _fn = async () => {
          const token = await getSubscriptionToken(app, {
            channel: staticChannel(),
            topics: ["created", "updated"],
          });

          const stream = await subscribe(token, (message) => {
            assertType<"static">(message.channel);
            assertType<"created" | "updated">(message.topic);

            if (message.topic === "created") {
              assertType<{ id: string; name: string }>(message.data);
            } else {
              assertType<boolean>(message.data);
            }
          });

          for await (const message of stream) {
            assertType<"static">(message.channel);
            assertType<"created" | "updated">(message.topic);

            if (message.topic === "created") {
              assertType<{ id: string; name: string }>(message.data);
            } else {
              assertType<boolean>(message.data);
            }
          }

          const reader = stream.getReader();
          const { value: message, done } = await reader.read();
          if (!done) {
            assertType<"static">(message.channel);
            assertType<"created" | "updated">(message.topic);

            if (message.topic === "created") {
              assertType<{ id: string; name: string }>(message.data);
            } else {
              assertType<boolean>(message.data);
            }
          }
        };
      });

      test("can subscribe with a type-only import dynamic typed token", () => {
        const _fn = async () => {
          const token = await getSubscriptionToken(app, {
            channel: typeOnlyChannel<typeof userChannel>("user/123"),
            topics: ["created", "updated"],
          });

          const stream = await subscribe(token, (message) => {
            assertType<`user/${string}`>(message.channel);
            assertType<"created" | "updated">(message.topic);

            if (message.topic === "created") {
              assertType<{ id: string; name: string }>(message.data);
            } else {
              assertType<boolean>(message.data);
            }
          });

          for await (const message of stream) {
            assertType<`user/${string}`>(message.channel);
            assertType<"created" | "updated">(message.topic);

            if (message.topic === "created") {
              assertType<{ id: string; name: string }>(message.data);
            } else {
              assertType<boolean>(message.data);
            }
          }

          const reader = stream.getReader();
          const { value: message, done } = await reader.read();
          if (!done) {
            assertType<`user/${string}`>(message.channel);
            assertType<"created" | "updated">(message.topic);

            if (message.topic === "created") {
              assertType<{ id: string; name: string }>(message.data);
            } else {
              assertType<boolean>(message.data);
            }
          }
        };
      });

      test("can subscribe with a runtime import dynamic typed token", () => {
        const _fn = async () => {
          const token = await getSubscriptionToken(app, {
            channel: userChannel("123"),
            topics: ["created", "updated"],
          });

          const stream = await subscribe(token, (message) => {
            assertType<`user/${string}`>(message.channel);
            assertType<"created" | "updated">(message.topic);

            if (message.topic === "created") {
              assertType<{ id: string; name: string }>(message.data);
            } else {
              assertType<boolean>(message.data);
            }
          });

          for await (const message of stream) {
            assertType<`user/${string}`>(message.channel);
            assertType<"created" | "updated">(message.topic);

            if (message.topic === "created") {
              assertType<{ id: string; name: string }>(message.data);
            } else {
              assertType<boolean>(message.data);
            }
          }

          const reader = stream.getReader();
          const { value: message, done } = await reader.read();
          if (!done) {
            assertType<`user/${string}`>(message.channel);
            assertType<"created" | "updated">(message.topic);

            if (message.topic === "created") {
              assertType<{ id: string; name: string }>(message.data);
            } else {
              assertType<boolean>(message.data);
            }
          }
        };
      });
    });
  });
});
