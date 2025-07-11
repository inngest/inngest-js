import { Button } from "@/components/ui/button";
import Link from "next/link";

export default async function SegmentPage({
  params,
}: {
  params: { id: string };
}) {
  const { id } = await params;
  console.log;
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_APP_URL}/api/segments/${id}`,
    { cache: "no-store" }
  );
  const { segment, contacts } = await res.json();
  return (
    <div className="max-w-2xl mx-auto py-12 flex flex-col gap-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">{segment.name}</h1>
        <Button asChild>
          <Link href={`/campaigns/new?segmentId=${segment.id}`}>
            Create Campaign
          </Link>
        </Button>
      </div>
      <div className="text-neutral-600 mb-4">{segment.description}</div>
      <h2 className="text-lg font-semibold mb-2">
        Contacts in this segment ({contacts.length})
      </h2>
      <ul className="space-y-2">
        {contacts.length === 0 && (
          <li className="text-neutral-500">No contacts in this segment.</li>
        )}
        {contacts.map((c: any) => (
          <li
            key={c.id}
            className="border rounded p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-2"
          >
            <div>
              <div className="font-semibold">
                {c.firstname} {c.lastname}
              </div>
              <div className="text-sm text-neutral-600">{c.email}</div>
              <div className="text-xs text-neutral-500">
                {c.position || c.role} at {c.company} ({c.industry})
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
