import { useMemo, useCallback } from "react";
import { useRealtime } from "inngest/react";
import { staticChannel, zodChannel } from "./channels";

const fetchToken = async () => "placeholder-token";

export const App = () => {
  const channel = useMemo(
    () => staticChannel({ chatUrn: "test:123" }),
    [],
  );

  const zodChan = useMemo(
    () => zodChannel({ chatUrn: "test:123" }),
    [],
  );

  const tokenFactory = useCallback(() => fetchToken(), []);

  const staticResult = useRealtime({
    channel,
    topics: ["status"],
    token: tokenFactory,
    enabled: true,
  });

  const zodResult = useRealtime({
    channel: zodChan,
    topics: ["status"],
    token: tokenFactory,
    enabled: true,
  });

  return (
    <div style={{ fontFamily: "monospace", padding: 24 }}>
      <h1>Webpack Realtime Repro</h1>

      <section>
        <h2>staticSchema channel</h2>
        <pre>
          connectionStatus: {staticResult.connectionStatus}
          {"\n"}
          messages: {staticResult.messages.all.length}
        </pre>
      </section>

      <section>
        <h2>zod channel</h2>
        <pre>
          connectionStatus: {zodResult.connectionStatus}
          {"\n"}
          messages: {zodResult.messages.all.length}
        </pre>
      </section>
    </div>
  );
};
