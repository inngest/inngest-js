import type { FunctionConfig } from "../../../src/types";

interface Props {
  config: FunctionConfig;
}

export const FunctionBlock = ({ config }: Props) => {
  return (
    <div class="border-slate-300 border-4 p-2 rounded shadow">
      {config.name}
    </div>
  );
};
