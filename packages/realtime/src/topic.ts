import { type StandardSchemaV1 } from "@standard-schema/spec";
import { type Realtime } from "./types.js";

/**
 * TODO
 */
export const topic: Realtime.Topic.Builder = (
  /**
   * TODO
   */
  id,
) => {
  return new TopicDefinitionImpl(id);
};

export class TopicDefinitionImpl<
  TTopicId extends string = string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TPublish = any,
  TSubscribe = TPublish,
> implements Realtime.Topic.Definition<TTopicId, TPublish, TSubscribe>
{
  public name: TTopicId;
  #schema?: StandardSchemaV1;

  constructor(name: TTopicId, schema?: StandardSchemaV1) {
    this.name = name;
    this.#schema = schema;
  }

  public type<
    const UPublish,
    const USubscribe = UPublish,
  >(): Realtime.Topic.Definition<TTopicId, UPublish, USubscribe> {
    return this as Realtime.Topic.Definition<TTopicId, UPublish, USubscribe>;
  }

  public schema<const TSchema extends StandardSchemaV1>(
    schema: TSchema,
  ): Realtime.Topic.Definition<
    TTopicId,
    StandardSchemaV1.InferInput<TSchema>,
    StandardSchemaV1.InferOutput<TSchema>
  > {
    return new TopicDefinitionImpl(this.name, schema);
  }

  public getSchema(): StandardSchemaV1 | undefined {
    return this.#schema;
  }
}
