import type { FunctionConfig } from "../../../src/types";
import { FunctionBlock } from "./FunctionBlock";
import { Spinner } from "./Loading";

export const Content = () => {
  const isReady = true;

  if (!isReady) {
    return <Spinner class="h-8 w-8" />;
  }

  const fns: FunctionConfig[] = [
    {
      id: "123",
      name: "Foo",
      steps: {},
      triggers: [
        {
          event: "demo/event.sent",
        },
      ],
    },
  ];

  return (
    <div class="flex flex-col gap-4 p-4">
      <div class="text-2xl">✅ Your functions are set up correctly</div>

      <div class="flex flex-row w-full justify-center mt-8">
        <div>
          <div class="flex w-[60rem] max-w-screen-md">Found 4 functions</div>
          <div class="flex flex-col">
            {fns.map((fn) => (
              <FunctionBlock config={fn} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
