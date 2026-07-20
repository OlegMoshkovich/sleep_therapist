"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AuthProvider, useAuth } from "../context/AuthContext";

const OPTIONS = [
  { label: "Financial Analyst", href: "/demo/analyst/studio" },
  { label: "Legal Counsel", href: "/demo/law/studio" },
  { label: "Sleep Therapist", href: "/demo/sleep/studio" },
] as const;

function ChooseContent() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/");
    }
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <main
        className="flex min-h-[100dvh] items-center justify-center"
        style={{ backgroundColor: "#ffffff" }}
      >
        <p className="text-sm text-gray-400">Loading…</p>
      </main>
    );
  }

  return (
    <main
      className="flex min-h-[100dvh] flex-col items-center px-6 pb-12 pt-24"
      style={{ backgroundColor: "#ffffff" }}
    >
      <p
        className="font-normal text-black"
        style={{
          fontFamily: "var(--font-inter), Inter, system-ui, sans-serif",
          letterSpacing: "normal",
          fontSize: "16px",
          fontWeight: 400,
        }}
      >
        The AI Research lab
      </p>

      <div className="mt-10 flex w-full max-w-[25rem] flex-col gap-3">
        {OPTIONS.map((opt) => (
          <Link
            key={opt.href}
            href={opt.href}
            className="block w-full border border-[#d1d5db] bg-transparent px-4 py-3 text-center text-sm font-normal text-gray-900 transition-colors hover:bg-black hover:text-white"
            style={{
              fontFamily: "var(--font-inter), Inter, system-ui, sans-serif",
              letterSpacing: "normal",
            }}
          >
            {opt.label}
          </Link>
        ))}
      </div>
    </main>
  );
}

export default function DemoChoosePage() {
  return (
    <AuthProvider>
      <ChooseContent />
    </AuthProvider>
  );
}
