"use client";

import { AuthProvider, useAuth } from "../../context/AuthContext";
import AuthModal from "../../components/AuthModal";
import ChatWindow from "../../components/chat/ChatWindow";

function SleepContent() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center flex-1 bg-[#E1DECF]">
        <p className="text-gray-400 text-sm font-serif">Loading...</p>
      </div>
    );
  }

  if (!user) {
    return <AuthModal />;
  }

  return <ChatWindow chatEndpoint="/api/chat/sleep/base" topic="sleep" />;
}

export default function SleepDemo() {
  return (
    <AuthProvider>
      <div className="flex flex-col bg-[#E1DECF]" style={{ height: "100dvh" }}>
        <SleepContent />
      </div>
    </AuthProvider>
  );
}
