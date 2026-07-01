import { stringify } from "./strings.ts";

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

  return new Promise(async (resolve, reject) => {
    try {
      let closed = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();

          heartbeatTimer = setInterval(() => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(value));
            } catch {
              // Controller was closed between the guard and the enqueue; ignore.
              closed = true;
              clearInterval(heartbeatTimer);
            }
          }, interval);

          const finalize = (data: unknown) => {
            clearInterval(heartbeatTimer);

            // `data` may be a `Promise`. If it is, we need to wait for it to
            // resolve before sending it. To support this elegantly we'll always
            // assume it's a promise and handle that case.
            void Promise.resolve(data)
              .then((resolvedData) => {
                if (closed) return;
                closed = true;
                controller.enqueue(encoder.encode(stringify(resolvedData)));
                controller.close();
              })
              .catch(() => {
                // Stream was already closed by the time the final value resolved.
              });
          };

          passFinalize(finalize);
        },
        cancel() {
          // Consumer closed the stream (e.g. upstream proxy disconnect).
          // Mark closed so the heartbeat self-cancels without throwing.
          closed = true;
          clearInterval(heartbeatTimer);
        },
      });

      resolve({ stream, finalize: await finalizeP });
    } catch (err) {
      reject(err);
    }
  });
};
