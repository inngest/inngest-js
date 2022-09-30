import type { FunctionConfig } from "../../../src/types";
import { FunctionBlock } from "./FunctionBlock";
import { Spinner } from "./Loading";

export const Content = () => {
  const isReady = true;

  if (!isReady) {
    return <Spinner class="h-8 w-8" />;
  }

  const fns: FunctionConfig[] = [
    {
      id: "send-pr-creation-alert",
      name: "Send PR creation alert",
      steps: {},
      triggers: [
        {
          event: "github/pull_request",
        },
      ],
    },
    {
      id: "send-welcome-email",
      name: "📧 Send welcome email",
      steps: {},
      triggers: [
        {
          event: "app/user.created",
        },
      ],
    },
    {
      id: "backfill-user-data",
      name: "Backfill user data",
      steps: {},
      triggers: [
        {
          event: "app/user.created",
        },
      ],
    },
    {
      id: "weekly-cleanup",
      name: "🧹 Weekly cleanup",
      steps: {},
      triggers: [
        {
          cron: "0 0 * * 0",
        },
      ],
    },
    {
      id: "process-profile-photos",
      name: "Process profile photos",
      steps: {},
      triggers: [
        {
          event: "app/user.profile.photo.updated",
        },
      ],
    },
  ];

  return (
    <>
      <div class="flex flex-col gap-4 p-20 bg-gray-100">
        <div class="text-3xl">✅ Your functions are set up correctly</div>
        <div>
          <code>inngest@v0.55.1</code>
        </div>
      </div>
      <div class="w-full flex items-center justify-center mt-8 p-4">
        <div class="w-[60rem] max-w-full">
          <div class="mb-8">Found 4 functions</div>
          <div class="flex flex-col">
            <div class="w-full grid grid-cols-[1fr_1fr_1fr] font-semibold border-b-2 border-slate-300 pb-1">
              <div>Name</div>
              <div>ID</div>
              <div>Event / Cron</div>
            </div>
            {fns.map((fn, i) => (
              <FunctionBlock config={fn} altBg={i % 2 === 0} />
            ))}
          </div>
        </div>
      </div>
    </>
  );
};
