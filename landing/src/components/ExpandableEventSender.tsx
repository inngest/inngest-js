import { useMemo, useState } from "preact/hooks";
import { Inngest } from "../../../src/components/Inngest";
import { classNames } from "../utils/classnames";
import { Button } from "./Button";
import { Wrapper } from "./Container";
import { IntrospectConsumer, IntrospectValue } from "./Introspect";
import { TextAreaInput } from "./TextInput";

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

  const { value } = introspect;
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

    if (!value) {
      // TODO: Error
      return;
    }

    const inngest = new Inngest({ name: value.appName, inngestBaseUrl: value.devServerURL, eventKey: "dev-server" });
    await inngest.send(JSON.parse(data));
  }

  /**
   * TODO
   *
   * - Add "history" section via localstorage
   */

  return (
    <Wrapper>
      <details class="border border-gray-200 p-4 flex flex-col cursor-pointer rounded-lg bg-white shadow-lg my-4">
        <summary class="select-none">Send a test event</summary>
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
            <div class="text-gray-500 text-sm">Ctrl + Enter to send</div>
            <Button type="submit">Send event</Button>
          </div>
        </form>
      </details>
    </Wrapper>
  );
};
