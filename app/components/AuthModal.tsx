"use client";

import Link from "next/link";
import { SignIn, SignUp, useUser } from "@clerk/nextjs";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type AuthModalProps = {
  redirectAfterLogin?: string;
};

/** Match studio sepia frame / line tokens. */
const SEPIA = {
  bg: "#d8d6c7",
  line: "#86806f",
  text: "#1f1d18",
  textMuted: "#86806f",
  surface: "#eceadd",
} as const;

export const clerkAppearance = {
  variables: {
    colorPrimary: SEPIA.text,
    colorBackground: SEPIA.bg,
    colorText: SEPIA.text,
    colorTextSecondary: SEPIA.textMuted,
    colorInputBackground: SEPIA.bg,
    colorInputText: SEPIA.text,
    borderRadius: "0px",
    fontFamily: "var(--font-app)",
    fontSize: "12px",
  },
  elements: {
    card: { boxShadow: "none", border: `1px solid ${SEPIA.line}`, backgroundColor: SEPIA.bg },
    cardBox: { boxShadow: "none" },
    header: { display: "none" },
    footer: { display: "none" },
    headerTitle: { display: "none" },
    headerSubtitle: { display: "none" },
    socialButtonsBlockButton: {
      border: `1px solid ${SEPIA.line} !important`,
      backgroundColor: "transparent !important",
      backgroundImage: "none !important",
      boxShadow: "none !important",
      color: SEPIA.text,
      borderRadius: "0",
      "&:hover": {
        backgroundColor: `${SEPIA.text} !important`,
        color: "#f6f7f2 !important",
        border: `1px solid ${SEPIA.line} !important`,
        boxShadow: "none !important",
      },
    },
    socialButtonsBlockButtonText: { color: "inherit" },
    socialButtonsProviderIcon: { display: "none" },
    lastAuthenticationStrategyBadge: {
      border: `1px solid ${SEPIA.line} !important`,
      boxShadow: "none",
      color: `${SEPIA.textMuted} !important`,
      backgroundColor: `${SEPIA.bg} !important`,
    },
    dividerLine: { backgroundColor: SEPIA.line },
    dividerText: "text-gray-500",
    formFieldLabel: { color: SEPIA.text, fontWeight: "400" },
    formFieldInput: {
      border: `1px solid ${SEPIA.line} !important`,
      backgroundColor: `${SEPIA.bg} !important`,
      color: SEPIA.text,
      borderRadius: "0",
      boxShadow: "none !important",
      fontSize: "12px",
      "&:focus": {
        border: `1px solid ${SEPIA.line} !important`,
        boxShadow: "none !important",
        outline: "none !important",
      },
    },
    formButtonPrimary: {
      backgroundColor: "transparent !important",
      backgroundImage: "none !important",
      color: `${SEPIA.text} !important`,
      border: `1px solid ${SEPIA.line} !important`,
      borderRadius: "0",
      boxShadow: "none !important",
      "&:hover": {
        backgroundColor: `${SEPIA.text} !important`,
        backgroundImage: "none !important",
        color: "#f6f7f2 !important",
        border: `1px solid ${SEPIA.line} !important`,
        boxShadow: "none !important",
      },
    },
    formButtonPrimary__hover: {
      backgroundColor: `${SEPIA.text} !important`,
      backgroundImage: "none !important",
      color: "#f6f7f2 !important",
      border: `1px solid ${SEPIA.line} !important`,
      boxShadow: "none !important",
    },
    footerActionLink: "text-black underline",
    identityPreviewText: "text-gray-900",
    identityPreviewEditButton: "text-black",
    formResendCodeLink: "text-black",
    otpCodeFieldInput: {
      border: `1px solid ${SEPIA.line} !important`,
      backgroundColor: SEPIA.bg,
      borderRadius: "0",
      boxShadow: "none !important",
    },
    alertText: "text-gray-800",
  },
};

export default function AuthModal({ redirectAfterLogin }: AuthModalProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { isSignedIn, isLoaded } = useUser();
  const redirect = redirectAfterLogin ?? pathname ?? "/demo";
  const [mode, setMode] = useState<"signin" | "signup">("signin");

  // Stash the demo the user is trying to reach so PostSignInRedirect can
  // recover the destination even if Clerk's OAuth flow drops it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (redirect && redirect.startsWith("/demo")) {
      window.sessionStorage.setItem("postSignInRedirect", redirect);
    }
  }, [redirect]);

  useEffect(() => {
    if (isLoaded && isSignedIn) {
      router.replace(redirect);
    }
  }, [isLoaded, isSignedIn, redirect, router]);

  return (
    <div className="min-h-screen" style={{ backgroundColor: SEPIA.bg }}>
      <div className="px-4 py-3" style={{ borderBottom: `1px solid ${SEPIA.line}` }}>
        <Link
          href="/demo"
          className="inline-flex items-center gap-1.5 text-sm transition-colors"
          style={{ color: SEPIA.textMuted }}
        >
          ← Back
        </Link>
      </div>
      <div className="flex flex-col items-center justify-center gap-4" style={{ minHeight: "calc(100vh - 45px)" }}>
        {mode === "signin" ? (
          <SignIn
            routing="hash"
            forceRedirectUrl={redirect}
            fallbackRedirectUrl="/demo"
            appearance={clerkAppearance}
          />
        ) : (
          <SignUp
            routing="hash"
            forceRedirectUrl={redirect}
            fallbackRedirectUrl="/demo"
            appearance={clerkAppearance}
          />
        )}
        <p style={{ color: SEPIA.textMuted, fontSize: "12px" }}>
          {mode === "signin" ? (
            <>
              Don&apos;t have an account?{" "}
              <button onClick={() => setMode("signup")} className="underline hover:opacity-70" style={{ color: SEPIA.text }}>
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button onClick={() => setMode("signin")} className="underline hover:opacity-70" style={{ color: SEPIA.text }}>
                Sign in
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
