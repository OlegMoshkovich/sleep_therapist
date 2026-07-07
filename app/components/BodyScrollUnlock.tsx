"use client";

import { useEffect } from "react";

export default function BodyScrollUnlock() {
  useEffect(() => {
    const prev = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    const prevHeight = document.body.style.height;
    const prevHtmlHeight = document.documentElement.style.height;

    document.body.style.overflow = "auto";
    document.body.style.height = "auto";
    document.documentElement.style.overflow = "auto";
    document.documentElement.style.height = "auto";

    return () => {
      document.body.style.overflow = prev;
      document.body.style.height = prevHeight;
      document.documentElement.style.overflow = prevHtml;
      document.documentElement.style.height = prevHtmlHeight;
    };
  }, []);

  return null;
}
