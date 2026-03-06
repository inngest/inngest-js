import type { UseRealtimeConnectionStatus, UseRealtimeRunStatus } from "inngest/react";

const connectionColors: Record<UseRealtimeConnectionStatus, string> = {
  idle: "bg-gray-400",
  connecting: "bg-yellow-400 animate-pulse",
  open: "bg-green-500",
  closed: "bg-gray-400",
  error: "bg-red-500",
};

const runLabels: Record<UseRealtimeRunStatus, string> = {
  unknown: "Waiting",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function StatusBadge({
  status,
  runStatus,
}: {
  status: UseRealtimeConnectionStatus;
  runStatus: UseRealtimeRunStatus;
}) {
  return (
    <div className="flex items-center gap-3 text-sm text-gray-600">
      <span className="flex items-center gap-1.5">
        <span
          className={`inline-block h-2 w-2 rounded-full ${connectionColors[status]}`}
        />
        {status}
      </span>
      <span className="text-gray-300">|</span>
      <span>{runLabels[runStatus]}</span>
    </div>
  );
}
