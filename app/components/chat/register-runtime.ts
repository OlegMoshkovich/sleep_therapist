"use client";

import { usePathname } from "next/navigation";
import { registerChatUiRuntime } from "@airlab/chat-ui/runtime";

import { useAuth } from "../../context/AuthContext";

registerChatUiRuntime({
  useAuth,
  usePathname,
});
