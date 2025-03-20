import Link from "next/link";
import Image from "next/image";
export default function Home() {
  return (
    <main className="min-h-screen p-8">
      {/* Header */}
      <header className="text-center mb-16 flex justify-center">
        <Image
          src="/inngest-logo.svg"
          alt="Inngest Logo"
          width={100}
          height={100}
        />
      </header>

      <h2 className="max-w-4xl mx-auto text-left font-bold text-2xl mb-5">
        Realtime demos
      </h2>

      {/* Cards Section */}
      <section className="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-8">
        <Link href="/hello-world" className="group">
          <div className="h-full p-6 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm hover:shadow-md transition-all duration-200">
            <h2 className="text-xl font-semibold mb-3 group-hover:text-gray-900 dark:group-hover:text-gray-100">
              Hello World!
            </h2>
            <p className="text-gray-600 dark:text-gray-400">
              Experience real-time data streaming directly from Inngest
              functions.
            </p>
          </div>
        </Link>

        <Link href="/agent-kit" className="group">
          <div className="h-full p-6 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm hover:shadow-md transition-all duration-200">
            <h2 className="text-xl font-semibold mb-3 group-hover:text-gray-900 dark:group-hover:text-gray-100">
              Simple Perplexity with AgentKit
            </h2>
            <p className="text-gray-600 dark:text-gray-400">
              Ask our simple agent to search the web in real-time.
            </p>
          </div>
        </Link>
      </section>
    </main>
  );
}
