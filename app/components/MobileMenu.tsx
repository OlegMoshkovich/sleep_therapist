'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface MobileMenuProps {
  showLinks: boolean;
  darkMode?: boolean;
}

export default function MobileMenu({ showLinks, darkMode = false }: MobileMenuProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const pathname = usePathname();

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = () => setShowDropdown(false);
    if (showDropdown) {
      document.addEventListener('click', handleClickOutside);
    }
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showDropdown]);

  if (!showLinks) {
    return null;
  }

  const links = [
    { href: '/', label: 'Directory' },
    { href: '/story', label: 'Pitch Deck' },
    { href: '/funding', label: 'Funding Info' },
    { href: '/problem', label: 'Research Paper' },
    { href: '/stack-analysis', label: 'Ecosystem' },
    { href: '/graphic-novel', label: 'Graphic Novel' },
  ];

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setShowDropdown(!showDropdown);
        }}
        onTouchStart={(e) => e.stopPropagation()}
        className={`text-sm font-light tracking-wider transition-colors border rounded-2xl pl-3 pr-2 py-0.5 flex items-center gap-1 ${
          darkMode 
            ? 'text-white border-gray-600 hover:text-gray-300' 
            : 'text-black border-gray-200 hover:text-gray-600'
        }`}
        style={{ touchAction: 'manipulation', pointerEvents: 'auto'}}
      >
        Links
        <svg 
          className={`w-3 h-3 transition-transform ${showDropdown ? 'rotate-180' : ''}`}
          fill="none" 
          stroke="currentColor" 
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      
      {showDropdown && (
        <div className="absolute right-0 top-6 bg-white border border-gray-200 min-w-[150px] z-[1000] rounded-2xl mt-2 pt-2 pb-2">
          {links.map(({ href, label }) => {
            const isActive = href === '/' 
              ? pathname === '/' 
              : pathname.startsWith(href);
            return (
              <Link 
                key={href}
                href={href}
                onClick={() => setShowDropdown(false)}
                className={`block w-full text-left px-4 py-3 sm:py-2 text-sm tracking-wide text-black ${
                  isActive ? 'underline' : 'hover:underline'
                } rounded-3xl`}
              >
                {label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
