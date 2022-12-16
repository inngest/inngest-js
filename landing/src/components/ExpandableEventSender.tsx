import { useMemo, useState } from "preact/hooks";
import { Inngest } from "../../../src/components/Inngest";
import { classNames } from "../utils/classnames";
import { Button } from "./Button";
import { Wrapper } from "./Container";
import { IntrospectConsumer, IntrospectValue } from "./Introspect";
import { TextAreaInput } from "./TextInput";
import useToast from "./Toast";

interface Props {
  expanded: boolean;
  onToggle?: () => void;
  eventData?: any;
}

export const ExpandableEventSender = (props: Props) => {
  return (
    <IntrospectConsumer>
      {introspect => <ExpandableEventSenderUI {...props} introspect={introspect} /> }
    </IntrospectConsumer>
  );
}


const ExpandableEventSenderUI = ({
  introspect,
  eventData,
}: Props & { introspect: IntrospectValue }) => {

  const { push } = useToast();
  const { value, devConnected } = introspect;
  const [data, setData] = useState(eventData || JSON.stringify({ name: "", data: {} }, undefined, "  "));

  const isValidData = useMemo(() => {
    try {
      JSON.parse(data || null);
      return true;
    } catch {
      return false;
    }
  }, [data]);

  const send = async (e: Event) => {
    // Attempt to send to the devserver.
    e.preventDefault();

    if (!value || !devConnected) {
      push({ type: "error", message: "You must run the dev server to send test events" });
      return;
    }

    const inngest = new Inngest({
      name: value.appName,
      inngestBaseUrl: value.devServerURL,
      eventKey: "dev-server",
      fetch: fetch.bind(window),
    });
    await inngest.send(JSON.parse(data));
    push({ type: "success", message: "Event sent.  Check your terminal for logs." });
  }

  return (
    <Wrapper>
      <details class="border border-gray-200 p-4 flex flex-col cursor-pointer rounded-lg bg-white shadow-lg my-4">
        <summary class="select-none">Send a test event to trigger functions</summary>

        <div className="pt-1 pb-2 text-gray-500 text-sm">Send a test event as JSON to the Inngest dev server. This will trigger any functions that run from this event.</div>

        <form class="flex-1" onSubmit={send}>
          <div class="my-4">
            <TextAreaInput
              label="Event data (JSON)"
              className={classNames({
                "font-mono overflow-y-scroll h-48 resize-none": true,
                "bg-red-100": !isValidData,
              })}
              value={data}
              onChange={setData}
            />
          </div>
          <div class="flex flex-row justify-end space-x-4 items-center italic">
            {
              devConnected ? (
                <div class="text-gray-500 text-sm">Ctrl + Enter to send</div>
              ) : (
                <div class="text-red-600 text-sm">Run the dev server to send test events</div>
              )
            }
            <Button type="submit" disabled={!devConnected}>Send event</Button>
          </div>
        </form>
      </details>
    </Wrapper>
  );
};
