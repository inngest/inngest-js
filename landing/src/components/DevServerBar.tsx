import { classNames } from "../utils/classnames";
import { Code } from "./Code";
import { IntrospectConsumer, IntrospectValue } from "./Introspect";

const defaultURL = "http://localhost:8288";

/**
 * A nav bar intended to be at the top of the page.
 */
export const DevServerBar = () => {
  return (
    <IntrospectConsumer>
      {(value) => (
        <div class="bg-gray-200 top-0 w-full p-4 flex flex-row items-center gap-5">
          <div class="font-medium text-gray-900 text-xl">Inngest SDK</div>
          <div class="h-6 w-1 bg-gray-300" />
          <DevServerPill introspect={value} />
          {/* <a href="#" class="text-gray-700 font-semibold">
          Learn more
        </a> */}
        </div>
      )}
    </IntrospectConsumer>
  );
};

/**
 * A large pill showing dev server connection status.
 */
const DevServerPill = ({ introspect }: { introspect: IntrospectValue }) => {
  const { value: data, devConnected: connected } = introspect;

  const url = new URL(data?.devServerURL || defaultURL);
  url.pathname = "dev";

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
            Connected to <code>inngest dev</code> on{" "}
            <code>
              <a href={`http://${url.hostname}:${url.port}`}>{url.hostname}:{url.port}</a>
            </code>
          </div>
        ) : (
          <div>
            Not connected to <code>inngest dev</code>
          </div>
        )}
      </div>
      {!connected ? (
        <>
          <div className="text-sm">Run the dev server: </div>
          <Code
            copiable
            value={`npx inngest-cli@latest dev -u ${window.location.href}`}
          />
        </>
      ) : null}
    </>
  );
};
