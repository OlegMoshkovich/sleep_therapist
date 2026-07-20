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
      style={{ backgroundColor: "#ffffff" }}
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
      style={{ backgroundColor: "#ffffff" }}
    >
      <Splash />
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

      {/* Fixed-height slot so the form → loading → button swap on login never
          changes the layout height (which otherwise makes the page jump). */}
      <div className="flex min-h-[460px] w-full flex-col items-center justify-start">
      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : user ? (
        <Link
          href={STUDIO_PATH}
          className="rounded-full border border-black/20 bg-white px-6 py-3 text-center text-sm font-bold text-black transition hover:bg-black hover:text-white"
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
              forceRedirectUrl={STUDIO_PATH}
              fallbackRedirectUrl={STUDIO_PATH}
              appearance={homeAppearance}
            />
          ) : (
            <SignUp
              routing="hash"
              forceRedirectUrl={STUDIO_PATH}
              fallbackRedirectUrl={STUDIO_PATH}
              appearance={homeAppearance}
            />
          )}
          <p className="text-sm text-gray-600">
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
