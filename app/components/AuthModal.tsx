"use client";

import Link from "next/link";
import { SignIn, SignUp, useUser } from "@clerk/nextjs";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type AuthModalProps = {
  redirectAfterLogin?: string;
};

export const clerkAppearance = {
  variables: {
    colorPrimary: "#000000",
    colorBackground: "#ffffff",
    colorText: "#1a1a1a",
    colorTextSecondary: "#6b7280",
    colorInputBackground: "#ffffff",
    colorInputText: "#1a1a1a",
    borderRadius: "0px",
    fontFamily: "var(--font-app)",
    fontSize: "14px",
  },
  elements: {
    card: { boxShadow: "none", border: "1px solid rgb(209,213,219)", backgroundColor: "#ffffff" },
    cardBox: { boxShadow: "none" },
    header: { display: "none" },
    footer: { display: "none" },
    headerTitle: { display: "none" },
    headerSubtitle: { display: "none" },
    socialButtonsBlockButton: {
      border: "1px solid #d1d5db !important",
      backgroundColor: "transparent !important",
      backgroundImage: "none !important",
      boxShadow: "none !important",
      color: "#111827",
      borderRadius: "0",
      "&:hover": {
        backgroundColor: "#000000 !important",
        color: "#ffffff !important",
        border: "1px solid #d1d5db !important",
        boxShadow: "none !important",
      },
    },
    socialButtonsBlockButtonText: { color: "inherit" },
    socialButtonsProviderIcon: { display: "none" },
    lastAuthenticationStrategyBadge: {
      border: "1px solid #d1d5db !important",
      boxShadow: "none",
      color: "#6b7280 !important",
      backgroundColor: "#ffffff !important",
    },
    dividerLine: { backgroundColor: "#d1d5db" },
    dividerText: "text-gray-500",
    formFieldLabel: { color: "#000000", fontWeight: "400" },
    formFieldInput: {
      border: "1px solid #d1d5db !important",
      backgroundColor: "#ffffff !important",
      color: "#111827",
      borderRadius: "0",
      boxShadow: "none !important",
      "&:focus": {
        border: "1px solid #d1d5db !important",
        boxShadow: "none !important",
        outline: "none !important",
      },
    },
    formButtonPrimary: {
      backgroundColor: "transparent !important",
      backgroundImage: "none !important",
      color: "#111827 !important",
      border: "1px solid #d1d5db !important",
      borderRadius: "0",
      boxShadow: "none !important",
      "&:hover": {
        backgroundColor: "#000000 !important",
        backgroundImage: "none !important",
        color: "#ffffff !important",
        border: "1px solid #d1d5db !important",
        boxShadow: "none !important",
      },
    },
    formButtonPrimary__hover: {
      backgroundColor: "#000000 !important",
      backgroundImage: "none !important",
      color: "#ffffff !important",
      border: "1px solid #d1d5db !important",
      boxShadow: "none !important",
    },
    footerActionLink: "text-black underline",
    identityPreviewText: "text-gray-900",
    identityPreviewEditButton: "text-black",
    formResendCodeLink: "text-black",
    otpCodeFieldInput: {
      border: "1px solid #d1d5db !important",
      backgroundColor: "#ffffff",
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
    <div className="min-h-screen bg-[#ffffff]">
      <div className="px-4 py-3 border-b border-gray-300">
        <Link href="/demo" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors">
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
        <p className="text-sm text-gray-600 font-serif">
          {mode === "signin" ? (
            <>
              Don&apos;t have an account?{" "}
              <button onClick={() => setMode("signup")} className="underline text-gray-900 hover:text-gray-600">
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button onClick={() => setMode("signin")} className="underline text-gray-900 hover:text-gray-600">
                Sign in
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
