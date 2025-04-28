/**
 * TODO
 */
export class StreamFanout<TInput = unknown> {
  #writers = new Set<WritableStreamDefaultWriter<TInput>>();

  /**
   * TODO
   */
  createStream<TOutput = TInput>(
    /**
     * TODO
     */
    transform?: (
      /**
       * TODO
       */
      chunk: TInput,
    ) => TOutput,
  ): ReadableStream<TOutput> {
    const { readable, writable } = new TransformStream<TInput, TOutput>({
      transform: (chunk, controller) => {
        controller.enqueue(
          transform ? transform(chunk) : (chunk as unknown as TOutput),
        );
      },
    });

    const writer = writable.getWriter();
    this.#writers.add(writer);

    // Eagerly remove the writer is the stream is closed
    writer.closed
      .catch(() => {}) // Suppress unhandled promise rejection to avoid noisy logs
      .finally(() => {
        this.#writers.delete(writer);
      });

    return readable;
  }

  /**
   * TODO
   */
  write(
    /**
     * TODO
     */
    chunk: TInput,
  ) {
    for (const writer of this.#writers) {
      writer.ready
        .then(() => writer.write(chunk))
        // Dereference the writer if we fail, as this means it's closed
        .catch(() => this.#writers.delete(writer));
    }
  }

  /**
   * TODO
   */
  close() {
    for (const writer of this.#writers) {
      try {
        writer.close();
      } catch {
        // Ignore errors, as we are closing the stream and the writer may
        // already be closed, especially if the stream is closed before the
        // writer is closed or if the stream is cancelled.
      }
    }

    this.#writers.clear();
  }

  /**
   * TODO
   */
  size() {
    return this.#writers.size;
  }
}
