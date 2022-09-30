import { useMemo } from "preact/hooks";
import type { FunctionConfig } from "../../../src/types";
import { classNames } from "../utils/classnames";

interface Props {
  config: FunctionConfig;
  altBg?: boolean;
}

export const FunctionBlock = ({ config, altBg }: Props) => {
  const type = useMemo<"cron" | "event">(() => {
    const trigger = config.triggers[0] as any;
    if (trigger.cron) return "cron";
    return "event";
  }, [config.triggers]);

  const expression = useMemo(() => {
    const trigger = config.triggers[0] as any;
    return trigger.cron || trigger.event || "";
  }, [config.triggers]);

  return (
    <div
      class={classNames({
        "w-full grid grid-cols-[1fr_1fr_1fr] p-2 items-center": true,
        "bg-slate-300/30": Boolean(altBg),
      })}
    >
      <div class="flex flex-col">
        <div class="font-semibold text-sm">
          {config.name}{" "}
          <span
            class={classNames({
              "uppercase text-xs px-1 py-0.5 rounded": true,
              "bg-blue-300/30": type === "event",
              "bg-green-300/30": type === "cron",
            })}
          >
            {type}
          </span>
        </div>
      </div>
      <div>
        <code class="text-xs bg-gray-500/10 text-gray-500">{config.id}</code>
      </div>
      <span>
        <code>{expression}</code>
      </span>
    </div>
  );
};
