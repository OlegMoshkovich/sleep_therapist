'use client';

import { useState, useEffect } from 'react';

interface LinkItem {
  label: string;
  href: string;
  isExternal?: boolean;
}

const directoryLinks: LinkItem[] = [
  { label: 'Roadmap', href: '/roadmap', isExternal: false },
  { label: 'Progress', href: 'https://docs.google.com/presentation/d/1gqjyuQrxjGPlHPKU95izpaxY0XWH1TztmbCjR6WDGZo/edit?usp=sharing', isExternal: true },
  { label: 'Linear', href: 'https://linear.app/airesearchlab/team/AI/active', isExternal: true },
  { label: 'Drive', href: 'https://drive.google.com/drive/u/0/folders/1eW1uXuXpNaE7sKMa2SMPypn6M8zCdxHN', isExternal: true },
  { label: 'Figma', href: 'https://www.figma.com/design/U9RoYKTYbpAwjs7Bg8a3DU/AI.Research?node-id=0-1&p=f&t=8OaGut2nJNuVX3Dl-0', isExternal: true },
  { label: 'Pitch', href: 'https://app.pitch.com/app/presentation/2f76b33a-62ca-4535-9442-2a95731cc8f7/77d6cce8-c77e-4b18-80cf-987000e5e3e2', isExternal: true },
  { label: 'Miro', href: 'https://miro.com/app/board/uXjVN-c4VII=/', isExternal: true },
];

interface DirectoryDropdownProps {
  onRoadmapClick?: () => void;
}

export default function DirectoryDropdown({ onRoadmapClick }: DirectoryDropdownProps) {
  const [showDropdown, setShowDropdown] = useState(false);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = () => setShowDropdown(false);
    if (showDropdown) {
      document.addEventListener('click', handleClickOutside);
    }
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showDropdown]);

  const handleLinkClick = (link: LinkItem) => {
    if (link.label === 'Roadmap' && onRoadmapClick) {
      onRoadmapClick();
      setShowDropdown(false);
    } else if (link.isExternal) {
      window.open(link.href, '_blank', 'noopener,noreferrer');
      setShowDropdown(false);
    }
  };

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setShowDropdown(!showDropdown);
        }}
        onTouchStart={(e) => e.stopPropagation()}
        className="text-sm font-light tracking-wider whitespace-pre-line cursor-pointer border border-gray-200 rounded-2xl pl-3 pr-2 py-0.5 transition-colors flex items-center gap-1 text-black hover:text-gray-600"
        style={{ touchAction: 'manipulation', pointerEvents: 'auto' }}
      >
        Directory
        <svg 
          className={`w-3 h-3 ml-1 transition-transform ${showDropdown ? 'rotate-180' : ''}`}
          fill="none" 
          stroke="currentColor" 
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      
      {showDropdown && (
        <div className="absolute left-0 top-8 min-w-[150px] max-h-[60vh] overflow-y-auto z-[1000] rounded-2xl mt-1 py-2 shadow-lg bg-white border border-gray-200">
          {directoryLinks.map((link) => (
            <button
              key={link.label}
              type="button"
              onClick={() => handleLinkClick(link)}
              className="block w-full text-left px-4 py-2 transition-colors text-black hover:bg-gray-50"
            >
              <div className="text-sm font-light flex items-center gap-2">
                {link.label}
                {link.isExternal && (
                  <svg className="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

