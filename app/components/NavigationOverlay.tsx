"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

export default function NavigationOverlay() {
  const pathname = usePathname();
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest("a");
      if (!anchor) return;

      // Skip external links, anchors-only, or new-tab links
      if (anchor.target === "_blank") return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("http") || href.startsWith("mailto")) return;

      const newPath = href.split("?")[0].split("#")[0];
      const currentPath = window.location.pathname;

      if (newPath !== currentPath) {
        setIsVisible(true);
      }
    };

    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  // Hide when the new page finishes rendering
  useEffect(() => {
    setIsVisible(false);
  }, [pathname]);

  if (!isVisible) return null;

  return (
    <div className="fixed inset-0 z-[9999] bg-[#E1DECF] flex items-center justify-center">
      <div className="flex gap-2">
        <span className="w-2 h-2 rounded-full bg-gray-900 animate-bounce [animation-delay:-0.3s]" />
        <span className="w-2 h-2 rounded-full bg-gray-900 animate-bounce [animation-delay:-0.15s]" />
        <span className="w-2 h-2 rounded-full bg-gray-900 animate-bounce" />
      </div>
    </div>
  );
}
