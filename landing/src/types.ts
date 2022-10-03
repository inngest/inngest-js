import type {
  FunctionConfig as RawFunctionConfig,
  RegisterRequest,
} from "../../src/types";

/**
 * A unique assortment of configuration errors that can be rendered for any
 * given function.
 */
export enum ConfigErr {
  EmptyTrigger,
  NoTriggers,
}

/**
 * An extended `FunctionConfig` interface that includes a set of `ConfigErr`
 * that can be used to render errors for the given function in the UI.
 */
export interface FunctionConfig extends RawFunctionConfig {
  errors?: Set<ConfigErr>;
}

/**
 * The expected response from the SDK, including overwriting the `functions` key
 * so that we can type our own set of config errors.
 *
 * We can use this and assume it's correct instead of relying on a tool like Zod
 * because the landing page is bundled with the SDK, so will always know what to
 * expect.
 */
export interface ExpectedIntrospection extends RegisterRequest {
  functions: FunctionConfig[];
}
