'use client';

import { useState, useEffect } from 'react';
import { useTheme } from '../context/ThemeContext';

interface PasswordProtectionProps {
  children: React.ReactNode;
}

export default function PasswordProtection({ children }: PasswordProtectionProps) {
  const [isAuthenticated, setIsAuthenticated] = useState(
    process.env.NEXT_PUBLIC_TEST_MODE === "1"
  );
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [toggledSquares, setToggledSquares] = useState<Set<number>>(new Set());

  useEffect(() => {
    const savedAuth = sessionStorage.getItem('siteAuthenticated');
    const authType = sessionStorage.getItem('siteAuthType');
    if (savedAuth === 'true') {
      setIsAuthenticated(true);
      // Set cookie for middleware to check (if not already set)
      if (authType) {
        document.cookie = `siteAuthType=${authType}; path=/; max-age=86400`; // 24 hours
      }
    }

    // Prevent scrolling and viewport shift when password screen is shown (especially iOS Safari)
    if (!isAuthenticated) {
      const scrollY = window.scrollY;
      document.body.style.overflow = 'hidden';
      document.body.style.position = 'fixed';
      document.body.style.top = `-${scrollY}px`;
      document.body.style.left = '0';
      document.body.style.right = '0';
      document.body.style.width = '100%';
      document.documentElement.style.overflow = 'hidden';
      document.documentElement.style.height = '100%';
    }
    
    return () => {
      if (!isAuthenticated) {
        const scrollY = document.body.style.top;
        document.body.style.overflow = '';
        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.left = '';
        document.body.style.right = '';
        document.body.style.width = '';
        document.documentElement.style.overflow = '';
        document.documentElement.style.height = '';
        window.scrollTo(0, parseInt(scrollY || '0') * -1);
      }
    };
  }, [isAuthenticated]);



  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password === 'air' || password === 'us') {
      setIsAuthenticated(true);
      sessionStorage.setItem('siteAuthenticated', 'true');
      sessionStorage.setItem('siteAuthType', password);
      // Set cookie for middleware to check
      document.cookie = `siteAuthType=${password}; path=/; max-age=86400`; // 24 hours
      setError('');
    } else {
      setError('Incorrect password');
      setPassword('');
    }
  };

  if (isAuthenticated) {
    return <>{children}</>;
  }

  const handleInputBlur = () => {
    // Scroll to top to prevent viewport shift on iOS Safari
    window.scrollTo(0, 0);
  };


  const { backgroundColor } = useTheme();

  // 3x3 grid with THE AIR LAB
  const grid = [
    ['T', 'H', 'E'],
    ['A', 'I', 'R'],
    ['L', 'A', 'B']
  ];

  return (
    <div
      className="fixed inset-0 overflow-hidden transition-colors duration-500"
      style={{
        touchAction: 'none',
        overscrollBehavior: 'none',
        WebkitOverflowScrolling: 'touch',
        backgroundColor: '#E1DECF'
      }}
    >
      <style jsx>{`
        @media (max-width: 768px) {
          .logo-square {
            border-color: #E1DECF !important;
          }
        }
      `}</style>

      {/* Logo Grid - centered */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className="grid grid-cols-3 aspect-square max-w-[188px] md:max-w-[250px] w-full"
          style={{ gap: 0, margin: 0, padding: 0 }}
        >
          {grid.map((row, rowIndex) =>
            row.map((letter, colIndex) => {
              const index = rowIndex * 3 + colIndex;
              const isToggled = toggledSquares.has(index);

              const handleToggle = () => {
                setToggledSquares(prev => {
                  const newSet = new Set(prev);
                  if (newSet.has(index)) {
                    newSet.delete(index);
                  } else {
                    newSet.add(index);
                  }
                  return newSet;
                });
              };

              const handleTouchMove = (e: React.TouchEvent) => {
                e.preventDefault();
                const touch = e.touches[0];
                const element = document.elementFromPoint(touch.clientX, touch.clientY);
                const targetSquare = element?.closest('[data-square-index]');

                if (targetSquare) {
                  const targetIndex = parseInt(targetSquare.getAttribute('data-square-index') || '0');
                  setToggledSquares(prev => {
                    const newSet = new Set(prev);
                    if (newSet.has(targetIndex)) {
                      newSet.delete(targetIndex);
                    } else {
                      newSet.add(targetIndex);
                    }
                    return newSet;
                  });
                }
              };

              return (
                <div
                  key={`${rowIndex}-${colIndex}`}
                  data-square-index={index}
                  className={`
                    logo-square
                    flex items-center justify-center
                    transition-all duration-300 ease-in-out
                    cursor-pointer
                    ${isToggled ? 'bg-white' : 'bg-black'}
                  `}
                  onMouseEnter={handleToggle}
                  onClick={handleToggle}
                  onTouchStart={handleToggle}
                  onTouchMove={handleTouchMove}
                  style={{
                    aspectRatio: '1/1',
                    margin: 0,
                    padding: 0,
                    border: `1px solid ${isToggled ? 'white' : 'black'}`,
                    outline: 'none',
                    boxSizing: 'border-box'
                  }}
                >
                  <span
                    className={`
                      text-2xl md:text-4xl font-light tracking-widest
                      transition-all duration-300 ease-in-out
                      ${isToggled ? 'text-black' : 'text-white'}
                    `}
                    style={{
                      fontFamily: 'var(--font-archivo), system-ui, sans-serif'
                    }}
                  >
                    {letter}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
      
      {/* Bottom left password input */}
      <div className="fixed bottom-6 left-0 right-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-7">
          <form onSubmit={handleSubmit} className="flex flex-col items-start gap-1">
            <div className="relative">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onBlur={handleInputBlur}
                placeholder="Password"
                className="w-40 pl-3 py-2 pr-10 focus:outline-none text-black placeholder:text-sm text-sm"
                style={{ fontSize: '20px' }}
              />
              {password.length > 0 && (
                <button
                  type="submit"
                  className="absolute font-bold right-2 top-1/2 transform -translate-y-1/2 text-black py-1 px-1 hover:bg-gray-100 transition-colors"
                >
                  {'>'}
                </button>
              )}
            </div>
            {error && (
              <span className="text-red-600 text-sm pl-3">
                {error}
              </span>
            )}
          </form>
        </div>
      </div>
      {/* <footer className="fixed bottom-2 left-0 right-0 z-10 pointer-events-none">
        <div className="max-w-7xl mx-auto px-4 sm:px-8 flex justify-between items-center">
          <p className="text-xs font-light tracking-wide pointer-events-auto text-black">
            © The AI Research Lab 2026 All rights reserved
          </p>
        </div>
      </footer> */}
    </div>
  );
}