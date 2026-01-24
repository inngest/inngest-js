import type {
  SyncAdapterOptions,
  SyncHandlerOptions,
} from "./InngestCommHandler.ts";

export namespace InngestEndpointAdapter {
  export const Tag = "Inngest.EndpointAdapter" as const;

  // biome-ignore lint/suspicious/noExplicitAny: we don't care about the return
  export type Fn = (options: SyncHandlerOptions) => any;

  export interface Like extends Fn {
    readonly [Symbol.toStringTag]: typeof Tag;
    withOptions: (options: SyncAdapterOptions) => Like;
  }

  export const create = <TFn extends Fn>(rawFn: TFn): TFn & Like => {
    const scopedOptions: SyncAdapterOptions = {};
    const fn: Fn = (options) => rawFn({ ...scopedOptions, ...options });

    return Object.defineProperties(fn, {
      [Symbol.toStringTag]: { value: Tag },

      withOptions: {
        value: (options: SyncAdapterOptions) => {
          Object.assign(scopedOptions, options);
          return fn;
        },
      },
    }) as TFn & Like;
  };
}
