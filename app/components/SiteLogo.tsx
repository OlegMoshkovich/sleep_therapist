"use client";

import { useState } from "react";
import Link from "next/link";

const grid = [
  ['T', 'H', 'E'],
  ['A', 'I', 'R'],
  ['L', 'A', 'B'],
];

interface SiteLogoProps {
  size?: number;
  /**
   * Tailwind text-size class for the letters. When omitted, the letter size is
   * computed from `size` so it fills the square like the password-screen logo.
   */
  letterSize?: string;
  href?: string;
}

export default function SiteLogo({ size = 80, letterSize, href = "/" }: SiteLogoProps) {
  // Each cell is size/3 wide; ~55% of that reads as a bold, filled letter.
  const computedFontSize = Math.round((size / 3) * 0.4);
  const [toggledSquares, setToggledSquares] = useState<Set<number>>(new Set());

  const handleToggle = (index: number) => {
    setToggledSquares(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  return (
    <Link href={href}>
      <div
        className="grid grid-cols-3 aspect-square"
        style={{ width: size, gap: 0, margin: 0, padding: 0 }}
      >
        {grid.map((row, rowIndex) =>
          row.map((letter, colIndex) => {
            const index = rowIndex * 3 + colIndex;
            const isToggled = toggledSquares.has(index);
            return (
              <div
                key={`${rowIndex}-${colIndex}`}
                className={`flex items-center justify-center transition-all duration-300 ease-in-out cursor-pointer ${
                  isToggled ? "bg-white" : "bg-black"
                }`}
                onMouseEnter={() => handleToggle(index)}
                onClick={() => handleToggle(index)}
                onTouchStart={() => handleToggle(index)}
                style={{
                  aspectRatio: "1/1",
                  margin: 0,
                  padding: 0,
                  border: `1px solid ${isToggled ? "white" : "black"}`,
                  outline: "none",
                  boxSizing: "border-box",
                }}
              >
                <span
                  className={`${letterSize ?? ""} font-light tracking-widest transition-all duration-300 ease-in-out ${
                    isToggled ? "text-black" : "text-white"
                  }`}
                  style={{
                    fontFamily: "var(--font-archivo), system-ui, sans-serif",
                    ...(letterSize ? {} : { fontSize: computedFontSize }),
                  }}
                >
                  {letter}
                </span>
              </div>
            );
          })
        )}
      </div>
    </Link>
  );
}
