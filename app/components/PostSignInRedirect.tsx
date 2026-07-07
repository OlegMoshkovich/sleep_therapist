"use client";

import { useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import { usePathname, useRouter } from "next/navigation";

const STORAGE_KEY = "postSignInRedirect";

/**
 * Global safety net for post-sign-in navigation. AuthModal stashes the demo
 * the user was trying to reach; once Clerk reports them signed in (anywhere
 * in the app), we send them there. Handles the case where Clerk's OAuth flow
 * loses the `forceRedirectUrl` and lands on `/` instead of the demo.
 */
export default function PostSignInRedirect() {
  const { isLoaded, isSignedIn } = useUser();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    if (typeof window === "undefined") return;

    const target = window.sessionStorage.getItem(STORAGE_KEY);
    if (!target) return;
    window.sessionStorage.removeItem(STORAGE_KEY);

    if (target !== pathname) {
      router.replace(target);
    }
  }, [isLoaded, isSignedIn, pathname, router]);

  return null;
}
