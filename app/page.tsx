"use client";

import Link from "next/link";
import { SignIn, SignUp } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { clerkAppearance } from "./components/AuthModal";
import SiteLogo from "./components/SiteLogo";

// Where a signed-in visitor lands after auth — the studio chooser.
const AFTER_SIGN_IN_PATH = "/demo";

/** Match studio / AuthModal sepia frame. */
const SEPIA_BG = "#d8d6c7";
const SEPIA_TEXT = "#1f1d18";
const SEPIA_MUTED = "#86806f";
const SEPIA_LINE = "#a8a698";

// Shared width so the intro copy and the Clerk sign-in card line up exactly.
const CONTENT_WIDTH = "25rem";

// Clerk's card defaults to its own width; pin it to CONTENT_WIDTH so it matches
// the description container above it.
const homeAppearance = {
  ...clerkAppearance,
  variables: {
    ...clerkAppearance.variables,
    fontFamily: "var(--font-sans)",
  },
  elements: {
    ...clerkAppearance.elements,
    // Pin width only — leave Clerk’s default form layout untouched.
    rootBox: { width: "100%", maxWidth: CONTENT_WIDTH },
    card: {
      ...clerkAppearance.elements.card,
      width: "100%",
      maxWidth: CONTENT_WIDTH,
      border: "none",
      boxShadow: "none",
    },
  },
};

// Full-screen logo splash shown on first load: holds for 3s (the logo stays
// interactive during the hold), then fades out over 700ms and unmounts —
// letting pointer events through only once it starts fading.
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
      className={`fixed inset-0 z-50 flex items-center justify-center transition-opacity duration-700 ${
        phase === "fading" ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
      style={{ backgroundColor: SEPIA_BG }}
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
    window.sessionStorage.setItem("postSignInRedirect", AFTER_SIGN_IN_PATH);
  }, []);

  return (
    <main
      className="flex min-h-[100dvh] flex-col items-center px-6 pb-12 pt-24"
      style={{ backgroundColor: SEPIA_BG, color: SEPIA_TEXT }}
    >
      <Splash />
      <p
        className="font-normal"
        style={{
          fontFamily: "var(--font-inter), Inter, system-ui, sans-serif",
          letterSpacing: "normal",
          fontSize: "16px",
          fontWeight: 400,
          color: SEPIA_TEXT,
          transform: "translateY(-30px)",
        }}
      >
        The AI Research lab
      </p>
      <div className="mt-6">
        <SiteLogo size={96} href={false} />
      </div>

      <div className="mt-10 flex w-full flex-col items-center justify-start">
      {loading ? (
        <p className="text-sm" style={{ color: SEPIA_MUTED }}>Loading…</p>
      ) : user ? (
        <Link
          href={AFTER_SIGN_IN_PATH}
          className="border bg-transparent px-6 py-3 text-center text-sm font-normal transition-colors"
          style={{
            borderColor: SEPIA_LINE,
            color: SEPIA_TEXT,
          }}
        >
          Open the studio
        </Link>
      ) : (
        <div
          className="flex w-full flex-col items-center gap-4"
          style={{ maxWidth: CONTENT_WIDTH }}
        >
          {mode === "signin" ? (
            <SignIn
              routing="hash"
              forceRedirectUrl={AFTER_SIGN_IN_PATH}
              fallbackRedirectUrl={AFTER_SIGN_IN_PATH}
              appearance={homeAppearance}
            />
          ) : (
            <SignUp
              routing="hash"
              forceRedirectUrl={AFTER_SIGN_IN_PATH}
              fallbackRedirectUrl={AFTER_SIGN_IN_PATH}
              appearance={homeAppearance}
            />
          )}
          <p className="text-sm" style={{ color: SEPIA_MUTED }}>
            {mode === "signin" ? (
              <>
                Don&apos;t have an account?{" "}
                <button
                  onClick={() => setMode("signup")}
                  className="underline hover:opacity-70"
                  style={{ color: SEPIA_TEXT }}
                >
                  Sign up
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button
                  onClick={() => setMode("signin")}
                  className="underline hover:opacity-70"
                  style={{ color: SEPIA_TEXT }}
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
