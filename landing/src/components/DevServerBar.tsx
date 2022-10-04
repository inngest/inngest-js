import { useMemo } from "preact/hooks";
import { useAsyncRetry, useInterval } from "react-use";
import { classNames } from "../utils/classnames";
import { Code } from "./Code";

/**
 * A nav bar intended to be at the top of the page.
 */
export const DevServerBar = () => {
  return (
    <div class="bg-gray-200 top-0 w-full p-4 flex flex-row items-center gap-5">
      <div class="font-medium text-gray-900 text-xl">Inngest SDK</div>
      <div class="h-6 w-1 bg-gray-300" />
      <DevServerPill />
      {/* <a href="#" class="text-gray-700 font-semibold">
        Learn more
      </a> */}
    </div>
  );
};

interface DevServerInfo {
  /**
   * The version of the dev server.
   */
  version: string;
}

/**
 * A large pill showing dev server connection status.
 */
export const DevServerPill = () => {
  const {
    loading,
    value: devServer,
    error,
    retry,
  } = useAsyncRetry(async () => {
    const res = await fetch(new URL("http://localhost:8288/dev"));
    const result: DevServerInfo = await res.json();

    return result;
  });

  /**
   * Whenever the dev server isn't connected, keep trying every 5 seconds.
   */
  useInterval(retry, 5000);

  const connected = useMemo(() => Boolean(devServer), [devServer]);

  return (
    <>
      <div class="flex flex-row items-center gap-2 bg-slate-700 text-white py-1 px-3 rounded-full text-sm dark leading-none">
        <div class="flex h-4 w-4 relative">
          <span
            class={classNames({
              "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75":
                true,
              "bg-green-400": connected,
              "bg-red-400": !connected,
            })}
          />
          <span
            class={classNames({
              "relative inline-flex rounded-full h-4 w-4": true,
              "bg-green-500": connected,
              "bg-red-500": !connected,
            })}
          />
        </div>
        {connected ? (
          <div>
            Connected to <code>inngest dev</code> on <code>:8288</code>
          </div>
        ) : (
          <div>
            Not connected to <code>inngest dev</code>
          </div>
        )}
      </div>
      {!connected ? (
        <Code copiable value={`npx inngest-cli -u ${window.location.href}`} />
      ) : null}
    </>
  );
};
