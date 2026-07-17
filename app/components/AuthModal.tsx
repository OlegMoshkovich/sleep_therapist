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
    colorPrimary: "#1E2938",
    colorBackground: "#E1DECF",
    colorText: "#1a1a1a",
    colorTextSecondary: "#6b7280",
    colorInputBackground: "#E1DECF",
    colorInputText: "#1a1a1a",
    borderRadius: "0px",
    fontFamily: "var(--font-app)",
    fontSize: "14px",
  },
  elements: {
    card: { boxShadow: "none", border: "1px solid rgb(209,213,219)", backgroundColor: "#E1DECF" },
    cardBox: { boxShadow: "none" },
    header: { display: "none" },
    footer: { display: "none" },
    headerTitle: { display: "none" },
    headerSubtitle: { display: "none" },
    socialButtonsBlockButton: "border border-gray-400 bg-transparent hover:bg-gray-100 text-gray-900 rounded-none",
    socialButtonsBlockButtonText: "text-gray-900",
    dividerLine: "bg-gray-300",
    dividerText: "text-gray-500",
    formFieldLabel: "text-gray-800",
    formFieldInput: "border border-gray-400 bg-[#E1DECF] text-gray-900 rounded-none focus:border-gray-900 focus:ring-0 placeholder:text-gray-400",
    formButtonPrimary: "bg-[#1E2938] hover:bg-[#2d3d50] text-[#E1DECF] rounded-none shadow-none",
    footerActionLink: "text-[#1E2938] underline",
    identityPreviewText: "text-gray-900",
    identityPreviewEditButton: "text-[#1E2938]",
    formResendCodeLink: "text-[#1E2938]",
    otpCodeFieldInput: "border border-gray-400 bg-[#E1DECF] rounded-none",
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
    <div className="min-h-screen bg-[#E1DECF]">
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
