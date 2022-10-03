import type {
  FunctionConfig as RawFunctionConfig,
  RegisterRequest,
} from "../../src/types";

export enum ConfigErr {
  EmptyTrigger,
  NoTriggers,
}

export interface FunctionConfig extends RawFunctionConfig {
  errors?: Set<ConfigErr>;
}

export interface ExpectedIntrospection extends RegisterRequest {
  functions: FunctionConfig[];
}
