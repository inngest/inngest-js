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

    this.#writers.add(writable.getWriter());

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
      writer.close();
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
