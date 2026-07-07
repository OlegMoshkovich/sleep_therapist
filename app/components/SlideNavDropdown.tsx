'use client';

import { useState, useEffect } from 'react';

interface SlideItem {
  title: string;
  [key: string]: unknown;
}

interface SlideNavDropdownProps {
  slides: SlideItem[];
  currentSlide: number;
  onSlideSelect: (index: number) => void;
  darkMode?: boolean;
}

export default function SlideNavDropdown({ 
  slides, 
  currentSlide, 
  onSlideSelect,
  darkMode = false 
}: SlideNavDropdownProps) {
  const [showDropdown, setShowDropdown] = useState(false);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = () => setShowDropdown(false);
    if (showDropdown) {
      document.addEventListener('click', handleClickOutside);
    }
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showDropdown]);

  const currentTitle = slides[currentSlide]?.title || '';

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setShowDropdown(!showDropdown);
        }}
        onTouchStart={(e) => e.stopPropagation()}
        className={`text-sm font-light tracking-wider whitespace-pre-line cursor-pointer border rounded-2xl pl-3 pr-2 py-0.5 transition-colors flex items-center gap-1 ${
          darkMode
            ? 'text-white border-gray-600 hover:text-gray-300'
            : 'text-black border-gray-200 hover:text-gray-600'
        }`}
        style={{ touchAction: 'manipulation', pointerEvents: 'auto' }}
      >
        {currentTitle}
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
        <div 
          className={`absolute left-0 top-8 min-w-[200px] max-w-[300px] max-h-[60vh] overflow-y-auto z-[1000] rounded-2xl mt-1 py-2 shadow-lg ${
            darkMode
              ? 'bg-gray-900 border border-gray-700'
              : 'bg-white border border-gray-200'
          }`}
        >
          {slides.map((slide, index) => {
            const isActive = index === currentSlide;
            return (
              <button
                key={index}
                type="button"
                onClick={() => {
                  onSlideSelect(index);
                  setShowDropdown(false);
                }}
                className={`block w-full text-left px-4 py-2 transition-colors ${
                  darkMode
                    ? `text-white ${isActive ? 'bg-gray-800' : 'hover:bg-gray-800'}`
                    : `text-black ${isActive ? 'bg-gray-100' : 'hover:bg-gray-50'}`
                }`}
              >
                <div className={`text-sm whitespace-pre-line ${isActive ? 'font-medium' : 'font-light'}`}>
                  {slide.title}
                </div>
                <div className={`text-xs mt-0.5 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  Slide {index + 1} of {slides.length}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

