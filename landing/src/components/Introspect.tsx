import { ComponentChildren, createContext } from "preact";
import { useMemo } from "preact/hooks";
import { useAsyncRetry, useInterval } from "react-use";
import { DevServerInfo } from "../../../src/types";
import { useIntrospect } from "../hooks/useFnIntrospect";
import { ExpectedIntrospection } from "../types";

const defaultURL = "http://localhost:8288"

export type IntrospectValue = {
  value: ExpectedIntrospection | undefined;
  dev?: DevServerInfo;
  devConnected: boolean;
  retry: () => void;
  loading: boolean;
  error?: Error | undefined;
};

const Data = createContext<IntrospectValue>({
  value: undefined,
  retry: () => {},
  loading: false,
  devConnected: false,
});

export const IntrospectConsumer = Data.Consumer;

export const IntrospectProvider = ({ children }: { children: ComponentChildren }) => {
  const { value, retry, loading, error } = useIntrospect();

  const url = new URL(value?.devServerURL || defaultURL);
  url.pathname = "dev";

  const {
    value: dev,
    retry: retryDev,
  } = useAsyncRetry(async () => {
    const res = await fetch(url);
    const result: DevServerInfo = await res.json();
    return result;
  });

  /**
   * Whenever the dev server isn't connected, keep trying every 5 seconds.
   */
  useInterval(retryDev, 1000);

  const devConnected = useMemo(() => Boolean(dev), [dev]);

  return (
    <Data.Provider value={{ value, retry, loading, error, dev, devConnected }}>
      {children}
    </Data.Provider>
  );
}
