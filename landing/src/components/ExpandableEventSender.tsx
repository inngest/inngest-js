import { useMemo, useState } from "preact/hooks";
import { classNames } from "../utils/classnames";
import { Button } from "./Button";
import { Wrapper } from "./Container";
import { TextAreaInput, TextInput } from "./TextInput";

interface Props {
  expanded: boolean;
  onToggle?: () => void;
  eventName?: string;
  eventData?: any;
}

export const ExpandableEventSender = ({
  expanded,
  eventData,
  eventName,
  onToggle,
}: Props) => {
  const [name, setName] = useState(eventName || "");
  const [data, setData] = useState(eventData || "{}");

  const isValidData = useMemo(() => {
    try {
      JSON.parse(data || null);
      return true;
    } catch {
      return false;
    }
  }, [data]);

  /**
   * TODO
   *
   * - Add "history" section via localstorage
   * - Add "Invoke" button for
   */

  return (
    <Wrapper>
      <details class="border border-gray-200 p-4 flex flex-col cursor-pointer rounded-lg bg-white shadow-lg my-4">
        <summary class="select-none">Send a test event</summary>
        <div class="flex-1">
          <div class="my-4">
            <TextInput
              label="Event name"
              className="font-mono"
              value={name}
              onChange={setName}
            />
          </div>
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
            <Button>Send event</Button>
          </div>
        </div>
      </details>
    </Wrapper>
  );
};
