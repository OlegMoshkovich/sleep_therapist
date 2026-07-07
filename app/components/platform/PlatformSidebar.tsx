"use client";

import { useState } from "react";

interface SubItem {
  label: string;
}

interface Conversation {
  id: string;
  title: string;
  image: string;
  subItems?: SubItem[];
}

const CONVERSATIONS: Conversation[] = [
  {
    id: "creative-writing",
    title: "Creative Writing",
    image: "/platform_images/conversations/creative writing.png",
  },
  {
    id: "piano-chords",
    title: "Piano Chords for Beginners",
    image: "/platform_images/conversations/piano chords.png",
  },
  {
    id: "nutrition",
    title: "Nutrition",
    image: "/platform_images/conversations/yoga.png",
    subItems: [
      { label: "Sleeping Issues" },
      { label: "Weight Loss Questions" },
      { label: "Gluten-free Products" },
      { label: "Nutritional Value Labeling in Products" },
      { label: "Skin rash concerns" },
    ],
  },
  {
    id: "relationships",
    title: "Relationships",
    image: "/platform_images/conversations/relationships.png",
  },
  {
    id: "yoga",
    title: "Holistic Coaching",
    image: "/platform_images/conversations/yoga.png",
  },
];

interface PlatformSidebarProps {
  onNewConversation?: () => void;
  /** Mobile-only: render as full-screen overlay */
  mobileFullScreen?: boolean;
  /** Mobile-only: close the drawer */
  onClose?: () => void;
}

export default function PlatformSidebar({
  onNewConversation,
  mobileFullScreen = false,
  onClose,
}: PlatformSidebarProps) {
  const [expandedId, setExpandedId] = useState<string | null>("nutrition");

  function toggle(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  const containerClass = mobileFullScreen
    ? "w-full h-full bg-[#F0EDE6] flex flex-col overflow-y-auto"
    : "w-[300px] flex-shrink-0 bg-[#F0EDE6] border-r border-gray-200 flex flex-col h-full overflow-y-auto";

  return (
    <aside className={containerClass}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-5">
        <h2 className="font-bold text-black text-base font-sans">
          Your conversations
        </h2>
        <div className="flex items-center gap-3">
          {/* + new conversation */}
          <button
            onClick={onNewConversation}
            className="w-8 h-8 rounded-full border border-gray-400 flex items-center justify-center text-gray-600 hover:bg-gray-200 transition-colors"
            aria-label="New conversation"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="7" y1="1" x2="7" y2="13" />
              <line x1="1" y1="7" x2="13" y2="7" />
            </svg>
          </button>

          {/* Close — mobile drawer only */}
          {mobileFullScreen && onClose && (
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center text-gray-600 hover:text-gray-900 transition-colors"
              aria-label="Close"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="2" y1="2" x2="16" y2="16" />
                <line x1="16" y1="2" x2="2" y2="16" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Conversation list */}
      <ul className="flex flex-col px-3 pb-10 gap-0 md:gap-1">
        {CONVERSATIONS.map((conv) => {
          const isExpanded = expandedId === conv.id;
          const hasChildren = conv.subItems && conv.subItems.length > 0;

          return (
            <li key={conv.id}>
              <button
                onClick={() => hasChildren && toggle(conv.id)}
                className="w-full flex items-center gap-4 px-2 py-3 rounded-xl hover:bg-black/5 transition-colors group"
              >
                {/* Title */}
                <span className="flex-1 text-left text-sm font-sans text-gray-800 leading-snug">
                  {conv.title}
                </span>

                {/* Chevron */}
                <span className="text-gray-400 flex-shrink-0">
                  {hasChildren ? (
                    isExpanded ? (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="2,8 6,4 10,8" />
                      </svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="2,4 6,8 10,4" />
                      </svg>
                    )
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="4,2 8,6 4,10" />
                    </svg>
                  )}
                </span>
              </button>

              {/* Sub-items */}
              {hasChildren && isExpanded && (
                <ul className="pl-16 flex flex-col gap-0.5 py-1">
                  {conv.subItems!.map((sub) => (
                    <li key={sub.label}>
                      <button className="w-full text-left text-sm font-serif text-gray-500 py-1.5 hover:text-gray-900 transition-colors leading-snug">
                        {sub.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
