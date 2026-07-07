"use client";

import SiteLogo from "../SiteLogo";

interface PlatformTopNavProps {
  onLoginClick?: () => void;
  onMenuClick?: () => void;
}

export default function PlatformTopNav({ onLoginClick, onMenuClick }: PlatformTopNavProps) {
  return (
    <header className="w-full bg-[#F0EDE6] border-b border-gray-200 flex items-center px-4 md:px-6 py-3 gap-3 md:gap-4">
      {/* Logo — 32px on mobile, 48px on desktop */}
      <div className="flex-shrink-0 md:hidden">
        <SiteLogo size={32} letterSize="text-[6px]" href="/demo" />
      </div>
      <div className="flex-shrink-0 hidden md:flex">
        <SiteLogo size={48} letterSize="text-[8px]" href="/demo" />
      </div>

      {/* Search bar */}
      <div className="flex-1 flex justify-center">
        <div className="flex items-center gap-3 bg-white border border-gray-200 rounded-full px-4 md:px-5 py-2.5 w-full max-w-xl shadow-sm">
          <svg
            className="text-gray-400 flex-shrink-0"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Ask me anything"
            className="flex-1 bg-transparent outline-none text-gray-700 text-sm font-serif placeholder-gray-400 min-w-0"
          />
        </div>
      </div>

      {/* Log In — desktop only */}
      <button
        onClick={onLoginClick}
        className="hidden md:block flex-shrink-0 border border-gray-800 text-gray-800 text-sm font-sans font-medium px-6 py-2 rounded-full hover:bg-gray-800 hover:text-white transition-colors whitespace-nowrap"
      >
        Log In
      </button>

      {/* Hamburger — mobile only, right side */}
      <button
        onClick={onMenuClick}
        className="md:hidden flex-shrink-0 flex flex-col justify-center gap-[5px] w-8 h-8"
        aria-label="Open conversations"
      >
        <span className="block w-5 h-[2px] bg-gray-800 rounded-full" />
        <span className="block w-5 h-[2px] bg-gray-800 rounded-full" />
        <span className="block w-5 h-[2px] bg-gray-800 rounded-full" />
      </button>
    </header>
  );
}
