"use client";
import useSWR from "swr";
import Link from "next/link";
import { Button } from "@/components/ui/button";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export default function SegmentsList() {
  const { data: segments, error, isLoading } = useSWR("/api/segments", fetcher);

  if (isLoading) {
    return <div className="text-neutral-500">Loading segments...</div>;
  }
  if (error) {
    return <div className="text-red-500">Failed to load segments.</div>;
  }
  if (!segments || segments.length === 0) {
    return (
      <ul className="space-y-2">
        <li className="text-neutral-500">No segments found.</li>
      </ul>
    );
  }
  return (
    <ul className="space-y-2">
      {segments.map((segment: any) => (
        <li key={segment.id} className="border rounded p-4 flex flex-col gap-2">
          <div className="font-semibold flex items-center justify-between">
            <span>{segment.name}</span>
            <span className="text-xs text-neutral-500">
              {segment.contactCount} contact
              {segment.contactCount === 1 ? "" : "s"}
            </span>
          </div>
          <div className="text-neutral-600 text-sm mb-2">
            {segment.description}
          </div>
          <div>
            <Button asChild size="sm" variant="secondary">
              <Link href={`/segments/${segment.id}`}>View</Link>
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
