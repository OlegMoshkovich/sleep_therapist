"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useUser, useClerk } from "@clerk/nextjs";

type Role = "user" | "expert" | "admin";

interface AuthContextType {
  user: { id: string; email?: string; imageUrl?: string } | null;
  role: Role | null;
  expertDemos: string[];
  isAdmin: boolean;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  role: null,
  expertDemos: [],
  isAdmin: false,
  loading: true,
  signOut: async () => {},
});

const TEST_MODE = process.env.NEXT_PUBLIC_TEST_MODE === "1";

function readTestPersonaCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)x-test-user=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  return TEST_MODE ? (
    <TestAuthProvider>{children}</TestAuthProvider>
  ) : (
    <ClerkAuthProvider>{children}</ClerkAuthProvider>
  );
}

function ClerkAuthProvider({ children }: { children: ReactNode }) {
  const { user, isLoaded } = useUser();
  const { signOut: clerkSignOut } = useClerk();
  const [role, setRole] = useState<Role | null>(null);
  const [expertDemos, setExpertDemos] = useState<string[]>([]);

  const authUser = isLoaded && user
    ? { id: user.id, email: user.primaryEmailAddress?.emailAddress, imageUrl: user.imageUrl }
    : null;

  const authUserId = authUser?.id ?? null;

  useEffect(() => {
    if (!authUserId) {
      setRole(null);
      setExpertDemos([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/me/role");
        if (!res.ok) return;
        const data = (await res.json()) as {
          role: Role;
          expertDemos: string[];
        };
        if (cancelled) return;
        setRole(data.role);
        setExpertDemos(data.expertDemos ?? []);
      } catch {
        /* ignore — caller falls back to defaults */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authUserId]);

  return (
    <AuthContext.Provider value={{
      user: authUser,
      role,
      expertDemos,
      isAdmin: role === "admin",
      loading: !isLoaded,
      signOut: () => clerkSignOut(),
    }}>
      {children}
    </AuthContext.Provider>
  );
}

function TestAuthProvider({ children }: { children: ReactNode }) {
  const [persona, setPersona] = useState<string | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [expertDemos, setExpertDemos] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setPersona(readTestPersonaCookie());
  }, []);

  useEffect(() => {
    if (!persona || persona === "anon") {
      setRole(null);
      setExpertDemos([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/me/role");
        if (!res.ok) {
          if (!cancelled) setLoading(false);
          return;
        }
        const data = (await res.json()) as {
          role: Role;
          expertDemos: string[];
        };
        if (cancelled) return;
        setRole(data.role);
        setExpertDemos(data.expertDemos ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [persona]);

  const authUser =
    persona && persona !== "anon"
      ? { id: `test_${persona}`, email: `${persona}@test.local` }
      : null;

  async function signOut() {
    document.cookie = "x-test-user=; path=/; max-age=0";
    setPersona(null);
    setRole(null);
    setExpertDemos([]);
  }

  return (
    <AuthContext.Provider
      value={{
        user: authUser,
        role,
        expertDemos,
        isAdmin: role === "admin",
        loading,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
