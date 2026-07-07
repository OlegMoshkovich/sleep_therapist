"use client";

import { useChatUiAuth, useChatUiPathname } from "./runtime";

interface Conversation {
  id: string;
  title: string;
  updated_at: string;
}

interface ConversationSidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  demoTitle?: string;
  modelSetupHref?: string;
  modelSetupLabel?: string;
}

const DEMO_META: Array<{
  prefix: string;
  key: string;
  title: string;
  modelSetupHref: string;
  modelSetupLabel: string;
  expertDashboardHref: string;
}> = [
  {
    prefix: "/demo/research-assistant",
    key: "research-assistant",
    title: "Research Assistant",
    modelSetupHref: "/demo/research-assistant/input",
    modelSetupLabel: "Research Assistant model setup",
    expertDashboardHref: "/demo/research-assistant/expert-dashboard",
  },
  {
    prefix: "/demo/sleep",
    key: "sleep",
    title: "Sleep",
    modelSetupHref: "/demo/sleep/input",
    modelSetupLabel: "Sleep model setup",
    expertDashboardHref: "/demo/sleep/expert-dashboard",
  },
  {
    prefix: "/demo/dnd",
    key: "dnd",
    title: "Dungeons & Dragons",
    modelSetupHref: "/demo/dnd/input",
    modelSetupLabel: "D&D model setup",
    expertDashboardHref: "/demo/dnd/expert-dashboard",
  },
  {
    prefix: "/demo/nutrition",
    key: "nutrition",
    title: "Preventative medicine",
    modelSetupHref: "/demo/nutrition/input",
    modelSetupLabel: "Preventative medicine model setup",
    expertDashboardHref: "/demo/nutrition/expert-dashboard",
  },
];

function pathnameMatchesDemoPrefix(pathname: string | null, prefix: string) {
  return pathname === prefix || pathname?.startsWith(`${prefix}/`);
}

export default function ConversationSidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  demoTitle,
  modelSetupHref,
  modelSetupLabel,
}: ConversationSidebarProps) {
  const { user, expertDemos, isAdmin, signOut } = useChatUiAuth();
  const pathname = useChatUiPathname();
  const currentDemo =
    DEMO_META.find((demo) => pathnameMatchesDemoPrefix(pathname, demo.prefix)) ?? null;
  const canSeeExpertDashboard =
    !!currentDemo && (isAdmin || expertDemos.includes(currentDemo.key));
  const title = demoTitle ?? currentDemo?.title ?? "Agent-0";
  const resolvedModelSetupHref =
    modelSetupHref ?? (canSeeExpertDashboard ? currentDemo?.modelSetupHref : undefined);
  const resolvedModelSetupLabel =
    modelSetupLabel ?? currentDemo?.modelSetupLabel ?? "Model setup";

  return (
    <div className="w-full md:w-64 shrink-0 flex flex-col border-r border-gray-300 bg-[#d8d5c8] h-full">
      <div className="p-4 border-b border-gray-300">
        <h2 className="text-base font-bold font-test-american-grotesk text-black mb-3">
          {title}
        </h2>
        <button
          onClick={onNew}
          className="w-full bg-[#1E2938] text-[#E1DECF] text-sm py-2 px-3 hover:bg-[#2d3d50] transition-colors"
        >
          + New conversation
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 ? (
          <p className="text-xs text-gray-400 px-4 py-6 text-center">
            No conversations yet
          </p>
        ) : (
          conversations.map((convo) => (
            <div
              key={convo.id}
              className={`group flex items-center border-b border-gray-200 ${
                convo.id === activeId ? "bg-[#c4c1b4]" : "hover:bg-[#ccc9bc]"
              } transition-colors`}
            >
              <button
                onClick={() => onSelect(convo.id)}
                className={`flex-1 text-left px-4 py-3 text-sm truncate ${
                  convo.id === activeId ? "font-medium text-gray-900" : "text-gray-700"
                }`}
              >
                {convo.title}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(convo.id);
                }}
                className="opacity-0 group-hover:opacity-100 pr-3 text-gray-400 hover:text-red-500 transition-opacity text-xs shrink-0"
                title="Delete conversation"
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      <div className="p-4 border-t border-gray-300">
        <p className="text-xs text-gray-500 truncate mb-2">{user?.email}</p>
        {isAdmin && (
          <a
            href="/admin"
            className="block text-xs text-gray-500 underline hover:text-gray-700 mb-2"
          >
            Admin dashboard
          </a>
        )}
        {currentDemo && canSeeExpertDashboard && (
          <>
            <a
              href={currentDemo.expertDashboardHref}
              className="block text-xs text-gray-500 underline hover:text-gray-700 mb-2"
            >
              Records
            </a>
          </>
        )}
        {resolvedModelSetupHref && (
          <a
            href={resolvedModelSetupHref}
            className="block text-xs text-gray-500 underline hover:text-gray-700 mb-2"
          >
            {resolvedModelSetupLabel}
          </a>
        )}
        <button
          onClick={signOut}
          className="text-xs text-gray-500 underline hover:text-gray-700"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
