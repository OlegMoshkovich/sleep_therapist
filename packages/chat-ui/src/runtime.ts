"use client";

export interface ChatUiAuthUser {
  id: string;
  email?: string | null;
  imageUrl?: string | null;
}

export interface ChatUiAuthState {
  user: ChatUiAuthUser | null;
  expertDemos: string[];
  isAdmin: boolean;
  signOut: () => Promise<void> | void;
}

export interface ChatUiRuntime {
  useAuth: () => ChatUiAuthState;
  usePathname: () => string | null;
}

let runtime: ChatUiRuntime | null = null;

export function registerChatUiRuntime(nextRuntime: ChatUiRuntime): void {
  runtime = nextRuntime;
}

function getRuntime(): ChatUiRuntime {
  if (!runtime) {
    throw new Error("Chat UI runtime is not registered.");
  }
  return runtime;
}

export function useChatUiAuth(): ChatUiAuthState {
  return getRuntime().useAuth();
}

export function useChatUiPathname(): string | null {
  return getRuntime().usePathname();
}
