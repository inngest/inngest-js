import { stringify } from "./strings";

/**
 * Creates a {@link ReadableStream} that sends a `value` every `interval`
 * milliseconds as a heartbeat, intended to keep a stream open.
 *
 * Returns the `stream` itself and a `finalize` function that can be used to
 * close the stream and send a final value.
 */
export const createStream = (opts?: {
  /**
   * The interval in milliseconds to send a heartbeat.
   *
   * Defaults to `3000`.
   */
  interval?: number;

  /**
   * The value to send as a heartbeat.
   *
   * Defaults to `" "`.
   */
  value?: string;
}): Promise<{ finalize: (data: unknown) => void; stream: ReadableStream }> => {
  /**
   * We need to resolve this promise with both the stream and the `finalize`
   * function, but having them both instantiated synchronously is difficult, as
   * we need access to the stream's internals too.
   *
   * We create this cheeky deferred promise to grab the internal `finalize`
   * value. Be warned that simpler solutions may appear to compile, but fail at
   * runtime due to variables not being assigned; make sure to test your code!
   */
  let passFinalize: (value: (data: unknown) => void) => void;

  const finalizeP = new Promise<(data: unknown) => void>((resolve) => {
    passFinalize = resolve;
  });

  const interval = opts?.interval ?? 3000;
  const value = opts?.value ?? " ";

  // eslint-disable-next-line @typescript-eslint/no-misused-promises, no-async-promise-executor
  return new Promise(async (resolve, reject) => {
    try {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();

          const heartbeat = setInterval(() => {
            controller.enqueue(encoder.encode(value));
          }, interval);

          const finalize = (data: unknown) => {
            clearInterval(heartbeat);
            controller.enqueue(encoder.encode(stringify(data)));
            controller.close();
          };

          passFinalize(finalize);
        },
      });

      resolve({ stream, finalize: await finalizeP });
    } catch (err) {
      reject(err);
    }
  });
};
