import Link from "next/link";

export default function Home() {
  return (
    <main
      className="flex min-h-[100dvh] flex-col items-center justify-center gap-8 px-6"
      style={{ backgroundColor: "#E1DECF" }}
    >
      <div className="text-center">
        <p className="text-xs uppercase tracking-[0.28em] text-black/50">The AI Research Lab</p>
        <h1 className="mt-3 text-4xl font-bold text-black sm:text-5xl">Sleep Assistant</h1>
        <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-black/60">
          An AI sleep coach that reviews sleep logs, screens for red flags, and helps build a
          routine that sticks. Educational coaching only — not a diagnosis or medical treatment.
        </p>
      </div>

      <div className="flex flex-col items-stretch gap-3 sm:flex-row">
        <Link
          href="/sleep-assessment/hermes"
          className="rounded-full bg-[#F05025] px-6 py-3 text-center text-sm font-bold text-white transition hover:bg-black"
        >
          Start sleep assessment
        </Link>
        <Link
          href="/demo/sleep"
          className="rounded-full border border-black/20 bg-white px-6 py-3 text-center text-sm font-bold text-black transition hover:bg-black hover:text-white"
        >
          Open the chat
        </Link>
        <Link
          href="/demo/sleep/studio"
          className="rounded-full border border-black/20 bg-white px-6 py-3 text-center text-sm font-bold text-black transition hover:bg-black hover:text-white"
        >
          Open the studio
        </Link>
      </div>
    </main>
  );
}
