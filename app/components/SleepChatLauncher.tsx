"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

export default function SleepChatLauncher() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  if (pathname?.startsWith("/sleep-assessment") || pathname?.startsWith("/demo/sleep")) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 font-sans sm:bottom-6 sm:right-6">
      {open && (
        <div className="mb-3 w-[min(calc(100vw-2rem),360px)] overflow-hidden rounded-3xl border border-black/15 bg-[#f8f4e8] shadow-[0_24px_80px_rgba(0,0,0,0.28)]">
          <div className="border-b border-black/10 bg-black px-5 py-4 text-[#E1DECF]">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-[#E1DECF]/70">Sleep coach</p>
                <h2 className="mt-1 text-xl font-bold leading-tight">Build your sleep plan</h2>
              </div>
              <button
                type="button"
                aria-label="Close sleep coach preview"
                onClick={() => setOpen(false)}
                className="rounded-full border border-white/20 px-2.5 py-1 text-sm text-white/80 hover:bg-white/10"
              >
                ✕
              </button>
            </div>
          </div>
          <div className="space-y-4 px-5 py-5 text-black">
            <div className="rounded-2xl bg-white px-4 py-3 text-sm leading-relaxed shadow-sm">
              Hi — I can guide visitors through a 5-minute sleep assessment, screen for red flags, and create a practical 7-day routine.
            </div>
            <div className="grid grid-cols-3 gap-2 text-center text-[11px] uppercase tracking-[0.12em] text-black/60">
              <span className="rounded-full bg-black/5 px-2 py-2">Intake</span>
              <span className="rounded-full bg-black/5 px-2 py-2">Safety</span>
              <span className="rounded-full bg-black/5 px-2 py-2">Plan</span>
            </div>
            <Link
              href="/sleep-assessment/hermes"
              className="block rounded-full bg-[#F05025] px-5 py-3 text-center text-sm font-bold text-white transition hover:bg-black"
              onClick={() => setOpen(false)}
            >
              Start free sleep assessment
            </Link>
            <p className="text-xs leading-relaxed text-black/55">
              Educational coaching only; not a diagnosis, medical treatment, or emergency support.
            </p>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex items-center gap-3 rounded-full bg-black px-4 py-3 text-[#E1DECF] shadow-[0_14px_45px_rgba(0,0,0,0.25)] transition hover:-translate-y-0.5 hover:bg-[#F05025]"
        aria-expanded={open}
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#E1DECF] text-lg text-black">☾</span>
        <span className="hidden pr-1 text-sm font-bold sm:inline">Sleep assessment</span>
      </button>
    </div>
  );
}
