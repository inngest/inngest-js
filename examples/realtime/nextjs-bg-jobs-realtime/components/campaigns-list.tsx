"use client";
import useSWR from "swr";
import Link from "next/link";
import { Button } from "@/components/ui/button";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export default function CampaignsList() {
  const {
    data: campaigns,
    error,
    isLoading,
  } = useSWR("/api/campaigns", fetcher);

  if (isLoading) {
    return <div className="text-neutral-500">Loading campaigns...</div>;
  }
  if (error) {
    return <div className="text-red-500">Failed to load campaigns.</div>;
  }
  if (!campaigns || campaigns.length === 0) {
    return (
      <ul className="space-y-2">
        <li className="text-neutral-500">No campaigns found.</li>
      </ul>
    );
  }
  return (
    <ul className="space-y-2">
      {campaigns.map((campaign: any) => (
        <li
          key={campaign.id}
          className="border rounded p-4 flex justify-between items-center"
        >
          <span>{campaign.name || `Campaign #${campaign.id}`}</span>
          <Button asChild size="sm" variant="secondary">
            <Link href={`/campaign/${campaign.id}`}>View</Link>
          </Button>
        </li>
      ))}
    </ul>
  );
}
