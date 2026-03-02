import Link from "next/link";
import { Button } from "@/components/ui/button";

export function Navbar() {
  return (
    <nav className="w-full flex items-center justify-between py-4 px-8 border-b border-neutral-200 bg-white mb-8">
      <div className="text-xl font-bold tracking-tight text-neutral-900">
        <Link href="/">CampaignCraft</Link>
      </div>
      <div className="flex gap-4">
        <Button asChild variant="ghost">
          <Link href="/">Home</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/import">Import Contacts</Link>
        </Button>
      </div>
    </nav>
  );
}
