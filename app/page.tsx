"use client";

import Link from "next/link";
import { SignIn, SignUp } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { clerkAppearance } from "./components/AuthModal";
import SiteLogo from "./components/SiteLogo";

// Where a signed-in visitor lands. Sign-in redirects straight here so the
// landing page doubles as the login screen (see HomeContent).
const STUDIO_PATH = "/demo/sleep/studio";

// Full-screen logo splash shown on first load: holds for 3s, then fades out
// over 700ms and unmounts. Non-interactive so it never blocks the page beneath.
function Splash() {
  const [phase, setPhase] = useState<"hold" | "fading" | "gone">("hold");

  useEffect(() => {
    const fade = setTimeout(() => setPhase("fading"), 3000);
    const remove = setTimeout(() => setPhase("gone"), 3700);
    return () => {
      clearTimeout(fade);
      clearTimeout(remove);
    };
  }, []);

  if (phase === "gone") return null;

  return (
    <div
      className={`pointer-events-none fixed inset-0 z-50 flex items-center justify-center transition-opacity duration-700 ${
        phase === "fading" ? "opacity-0" : "opacity-100"
      }`}
      style={{ backgroundColor: "#E1DECF" }}
    >
      <SiteLogo size={120} />
    </div>
  );
}

function HomeContent() {
  const { user, loading } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup">("signin");

  // Mirror AuthModal: stash the destination so PostSignInRedirect can recover
  // it even if Clerk's OAuth flow drops the redirect param.
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem("postSignInRedirect", STUDIO_PATH);
  }, []);

  return (
    <main
      className="flex min-h-[100dvh] flex-col items-center justify-start gap-10 px-6 pb-12 pt-24"
      style={{ backgroundColor: "#E1DECF" }}
    >
      <Splash />
      <div className="text-center">
        <p className="text-xs uppercase tracking-[0.28em] text-black/50">The AI Research Lab</p>
        <h1 className="mt-3 text-3xl font-bold text-black sm:text-4xl">Sleep Assistant</h1>
        <p className="mx-auto mt-4 max-w-[25rem] text-sm leading-relaxed text-black/60">
          An AI sleep coach that reviews sleep logs, screens for red flags, and helps build a
          routine that sticks. Educational coaching only, not a diagnosis or medical treatment.
        </p>
      </div>

      {/* Fixed-height slot so the form → loading → button swap on login never
          changes the layout height (which otherwise makes the page jump). */}
      <div className="flex min-h-[460px] w-full flex-col items-center justify-start">
      {loading ? (
        <p className="text-sm font-serif text-gray-400">Loading…</p>
      ) : user ? (
        <Link
          href={STUDIO_PATH}
          className="rounded-full border border-black/20 bg-white px-6 py-3 text-center text-sm font-bold text-black transition hover:bg-black hover:text-white"
        >
          Open the studio
        </Link>
      ) : (
        <div className="flex flex-col items-center gap-4">
          {mode === "signin" ? (
            <SignIn
              routing="hash"
              forceRedirectUrl={STUDIO_PATH}
              fallbackRedirectUrl={STUDIO_PATH}
              appearance={clerkAppearance}
            />
          ) : (
            <SignUp
              routing="hash"
              forceRedirectUrl={STUDIO_PATH}
              fallbackRedirectUrl={STUDIO_PATH}
              appearance={clerkAppearance}
            />
          )}
          <p className="text-sm font-serif text-gray-600">
            {mode === "signin" ? (
              <>
                Don&apos;t have an account?{" "}
                <button
                  onClick={() => setMode("signup")}
                  className="text-gray-900 underline hover:text-gray-600"
                >
                  Sign up
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button
                  onClick={() => setMode("signin")}
                  className="text-gray-900 underline hover:text-gray-600"
                >
                  Sign in
                </button>
              </>
            )}
          </p>
        </div>
      )}
      </div>
    </main>
  );
}

export default function Home() {
  return (
    <AuthProvider>
      <HomeContent />
    </AuthProvider>
  );
}
