import {
  RemoteStateService,
  type MemoizedSteps,
  type StepResult,
} from "./middleware";

export namespace S3RemoteStateService {
  export type BucketKeyGenerator = (
    ctx: RemoteStateService.SaveStepContext
  ) => {
    bucket: string;
    key: string;
  };

  export interface Options {
    // naming lol
    generateBucketAndKey: BucketKeyGenerator;
  }
}

/**
 * A marker used to identify values with remote state.
 */
const REMOTE_STATE_MARKER = "__REMOTE_STATE__";

export interface RemoteStateValue {
  [REMOTE_STATE_MARKER]: true;
  bucket: string;
  key: string;
}

const isRemoteState = (value: unknown): value is RemoteStateValue => {
  return (
    typeof value === "object" &&
    value !== null &&
    REMOTE_STATE_MARKER in value &&
    value[REMOTE_STATE_MARKER] === true &&
    "bucket" in value &&
    typeof value["bucket"] === "string" &&
    "key" in value &&
    typeof value["key"] === "string"
  );
};

// faking it
declare const s3: {
  putObject: (bucket: string, key: string, data: string) => Promise<void>;
  getObject: (bucket: string, key: string) => Promise<string>;
};

export class S3RemoteStateService extends RemoteStateService {
  protected generateBucketAndKey: S3RemoteStateService.BucketKeyGenerator;

  constructor(opts: S3RemoteStateService.Options) {
    super();
    this.generateBucketAndKey = opts.generateBucketAndKey;
  }

  public async saveStep(
    ctx: RemoteStateService.SaveStepContext
  ): Promise<StepResult> {
    const { bucket, key } = this.generateBucketAndKey(ctx);
    const data = JSON.stringify(ctx.result); // dangerous and greedy - do we need all of this? Circular references?

    await s3.putObject(bucket, key, data);

    return {
      ...ctx.result,
      data: {
        [REMOTE_STATE_MARKER]: true,
        bucket,
        key,
      } satisfies RemoteStateValue,
    };
  }

  public async loadSteps(
    ctx: RemoteStateService.LoadStepsContext
  ): Promise<MemoizedSteps> {
    /**
     * This is lazy. There's also the option to batch load all of the data at
     * once, as we have access to all of the keys we need to fetch here.
     */
    const steps = await Promise.all(
      ctx.steps.map(async (step) => {
        if (!isRemoteState(step.data)) {
          return step;
        }

        const data = await s3.getObject(step.data.bucket, step.data.key);

        return {
          ...step,
          data: JSON.parse(data),
        };
      })
    );

    return steps;
  }
}

// test
const foo = new S3RemoteStateService({
  generateBucketAndKey: (ctx) => {
    // just based on run ID, which is flawed af but whatever until we get
    // the step ID exposed
    return {
      bucket: "my-bucket-whatever",
      key: `run-${ctx.runId}`,
    };
  },
});
