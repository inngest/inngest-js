import { useState } from "preact/hooks";
import { classNames } from "../utils/classnames";

export const DevServerBar = () => {
  return (
    <div class="bg-gray-200 top-0 w-full p-4 flex flex-row items-center gap-5">
      <div class="font-medium text-gray-900 text-xl">Inngest SDK</div>
      {/* <div class="h-6 w-1 bg-gray-300" />
      <DevServerPill />

      <a href="#" class="text-gray-700 font-semibold">
        Learn more
      </a> */}
    </div>
  );
};

export const DevServerPill = () => {
  const [on, setOn] = useState(true);

  return (
    <div
      class="flex flex-row items-center gap-2 bg-slate-700 text-white py-1 px-3 rounded-full text-sm dark leading-none"
      onClick={() => setOn((b) => !b)}
    >
      <div class="flex h-4 w-4 relative">
        <span
          class={classNames({
            "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75":
              true,
            "bg-green-400": on,
            "bg-red-400": !on,
          })}
        />
        <span
          class={classNames({
            "relative inline-flex rounded-full h-4 w-4": true,
            "bg-green-500": on,
            "bg-red-500": !on,
          })}
        />
      </div>
      {on ? (
        <div>
          Connected to <code>inngest dev</code> on <code>:5432</code>
        </div>
      ) : (
        <div>
          Not connected to <code>inngest dev</code>
        </div>
      )}
    </div>
  );
};
