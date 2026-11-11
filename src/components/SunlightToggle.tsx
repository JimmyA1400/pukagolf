"use client";

import { useEffect, useState } from "react";

/** Read by the inline script in app/layout.tsx too; keep the two in step. */
export const SUNLIGHT_KEY = "pukagolf:sunlight";

/**
 * Sunlight mode: white paper, black ink and a size up, for reading a phone
 * on the course at noon. A per-phone choice, so it lives in this browser
 * rather than the account — the same player may want it outside and not on
 * the sofa.
 */
export function SunlightToggle({ className = "" }: { className?: string }) {
  const [on, setOn] = useState(false);

  // The layout's inline script has already applied it before first paint;
  // this only brings the button's own state into line.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOn(document.documentElement.hasAttribute("data-sunlight"));
  }, []);

  const toggle = () => {
    const next = !on;
    document.documentElement.toggleAttribute("data-sunlight", next);

    try {
      if (next) localStorage.setItem(SUNLIGHT_KEY, "1");
      else localStorage.removeItem(SUNLIGHT_KEY);
    } catch {
      // Blocked storage: it still works until the page is closed.
    }

    setOn(next);
  };

  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={toggle}
      title="Higher contrast and bigger type, for bright sun"
      className={`inline-flex min-h-11 items-center font-mono text-xs tracking-wider uppercase ${
        on ? "text-forest underline" : "text-ink-soft hover:text-ink"
      } ${className}`}
    >
      Sunlight
    </button>
  );
}
