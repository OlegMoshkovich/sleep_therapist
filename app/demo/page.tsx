"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AuthProvider, useAuth } from "../context/AuthContext";
import SiteLogo from "../components/SiteLogo";

const OPTIONS = [
  { label: "Analyst", href: "/demo/analyst/studio" },
  { label: "Council", href: "/demo/law/studio" },
  { label: "Therapist", href: "/demo/sleep/studio" },
] as const;

/* Match studio sepia tokens (--frame / --line / --text). */
const SEPIA = {
  bg: "#d8d6c7",
  line: "#a8a698",
  text: "#1f1d18",
  textMuted: "#86806f",
  hover: "#1f1d18",
  hoverInk: "#f6f7f2",
} as const;

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
        style={{ backgroundColor: SEPIA.bg }}
        aria-busy="true"
        aria-label="Loading"
      >
        <SiteLogo size={120} href={false} />
      </main>
    );
  }

  return (
    <main
      className="flex min-h-[100dvh] flex-col items-center px-6 pb-12 pt-24"
      style={{ backgroundColor: SEPIA.bg, color: SEPIA.text }}
    >
      <p
        className="font-normal"
        style={{
          fontFamily: "var(--font-inter), Inter, system-ui, sans-serif",
          letterSpacing: "normal",
          fontSize: "16px",
          fontWeight: 400,
          color: SEPIA.text,
        }}
      >
        The AI Research lab
      </p>

      <div className="mt-10 flex w-full max-w-[25rem] flex-col gap-3">
        {OPTIONS.map((opt) => (
          <Link
            key={opt.href}
            href={opt.href}
            className="demo-choose-link block w-full bg-transparent px-4 py-3 text-center text-sm font-normal transition-colors"
            style={{
              fontFamily: "var(--font-inter), Inter, system-ui, sans-serif",
              letterSpacing: "normal",
              color: SEPIA.text,
              border: `1px solid ${SEPIA.line}`,
            }}
          >
            {opt.label}
          </Link>
        ))}
      </div>
      <style jsx>{`
        .demo-choose-link:hover {
          background: ${SEPIA.hover};
          color: ${SEPIA.hoverInk};
          border-color: ${SEPIA.hover};
        }
      `}</style>
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
