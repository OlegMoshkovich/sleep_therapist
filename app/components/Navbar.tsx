'use client';

import Link from 'next/link';
import { useTheme } from '../context/ThemeContext';

interface NavbarProps {
  darkMode?: boolean;
  showAbout?: boolean;
  showProposal?: boolean;
  transparent?: boolean;
  onNavClick?: () => void;
  onPrinciplesClick?: () => void;
}

export function Navbar({ darkMode = false, showAbout = true, showProposal = true, transparent = false, onNavClick, onPrinciplesClick }: NavbarProps) {
  const { backgroundColor } = useTheme();

  return (
    <nav
      className="fixed top-0 left-0 right-0 z-50 transition-colors duration-500"
      style={{ backgroundColor: transparent ? 'transparent' : backgroundColor }}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-3">
        <div className="flex justify-between items-center">
          {/* Left - Principles */}
          {showAbout ? (
            <div
              onClick={onPrinciplesClick}
              className="text-sm font-light tracking-wide text-white hover:text-gray-500 transition-colors cursor-pointer"
            >
              Principles
            </div>
          ) : (
            <span />
          )}

          {/* Center - AIR Lab */}
          <div
            className="text-sm  tracking-wide text-white hover:text-gray-500 transition-colors"
          >
            The AI Research Lab
          </div>

          {/* Right - Proposal */}
          {showProposal ? (
            <div
              onClick={onNavClick}
              className="text-sm font-light tracking-wide text-white hover:text-gray-500 transition-colors cursor-pointer"
            >
              Proposal
            </div>
          ) : (
            <span />
          )}
        </div>
      </div>
    </nav>
  );
}
