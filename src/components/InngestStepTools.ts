import { StepOpCode } from "../types";

export class InngestStepTools {
  public waitForEvent(): [StepOpCode.WaitForEvent, string] {
    return [StepOpCode.WaitForEvent, "yeah"];
  }
}
