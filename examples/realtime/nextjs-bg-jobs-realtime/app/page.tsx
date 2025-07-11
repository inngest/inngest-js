import { Button } from "@/components/ui/button";
import Link from "next/link";
import SegmentsList from "@/components/segments-list";
import CampaignsList from "@/components/campaigns-list";

export default function Home() {
  return (
    <div className="flex flex-col gap-8 py-12">
      <h1 className="text-3xl font-bold mb-2">Welcome to CampaignCraft</h1>
      <p className="text-lg text-neutral-600 mb-6">
        Send personalized email campaigns with AI-powered segmentation and
        drafting.
      </p>
      <div className="flex gap-4 mb-8">
        <Button asChild>
          <Link href="/import">Import Contacts</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/campaigns/new">Create Campaign</Link>
        </Button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div>
          <h2 className="text-xl font-semibold mb-2">Recent Campaigns</h2>
          <CampaignsList />
        </div>
        <div>
          <h2 className="text-xl font-semibold mb-2">Segments</h2>
          <SegmentsList />
        </div>
      </div>
    </div>
  );
}
