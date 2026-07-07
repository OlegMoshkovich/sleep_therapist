'use client';

import { createContext, useContext, useState, ReactNode } from 'react';

interface ThemeContextType {
  backgroundColor: string;
  setBackgroundColor: (color: string) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [backgroundColor, setBackgroundColor] = useState('#1E2938');

  return (
    <ThemeContext.Provider value={{ backgroundColor, setBackgroundColor }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
