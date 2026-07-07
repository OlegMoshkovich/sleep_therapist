'use client';

import { useTheme } from '../context/ThemeContext';

interface FooterProps {
  darkMode?: boolean;
  showColorPicker?: boolean;
}

const colors = ['#9B8B7E',  '#1E2938'];

export function Footer({ darkMode = false, showColorPicker = true }: FooterProps) {
  const { backgroundColor, setBackgroundColor } = useTheme();

  // Get the next color in the cycle
  const getNextColor = () => {
    const currentIndex = colors.indexOf(backgroundColor);
    const nextIndex = (currentIndex + 1) % colors.length;
    return colors[nextIndex];
  };

  const nextColor = getNextColor();

  return (
    <footer className="fixed bottom-2 left-0 right-0 z-10 pointer-events-none">
      <div className="max-w-7xl mx-auto px-4 sm:px-8 flex justify-between items-center">
        <p className={`text-xs font-light tracking-wide pointer-events-auto ${darkMode ? 'text-gray-200' : 'text-gray-200'}`}>
          © The AI Research Lab 2026 All rights reserved
        </p>

        {showColorPicker && (
          <button
            onClick={() => setBackgroundColor(nextColor)}
            className="pt-3 pb-3 pl-3 hover:scale-110 transition-transform cursor-pointer pointer-events-auto"
            aria-label="Change theme color"
          >
            <div
              className="w-3 h-3 "
              style={{ backgroundColor: nextColor }}
            />
          </button>
        )}
      </div>
    </footer>
  );
}