"use client";

import { useId, useState } from "react";

export type Tab = {
  id: string;
  label: string;
  content: React.ReactNode;
};

/**
 * Tabbed sections.
 *
 * Every panel stays mounted and only the inactive ones are hidden, so switching
 * tabs doesn't discard state — a half-typed score or an open location search
 * survives a trip to the other tab and back.
 */
export function Tabs({ tabs }: { tabs: Tab[] }) {
  const [active, setActive] = useState(tabs[0]?.id);
  const base = useId();

  return (
    <div className="min-w-0">
      {/* Four tabs fit a phone at the smaller size; wider screens get room. */}
      <div
        role="tablist"
        aria-label="League sections"
        className="section-head mb-4 flex flex-wrap gap-x-0 gap-y-1 pb-0 sm:gap-1"
      >
        {tabs.map((tab) => {
          const selected = tab.id === active;

          return (
            <button
              key={tab.id}
              role="tab"
              id={`${base}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${tab.id}`}
              onClick={() => setActive(tab.id)}
              className={`-mb-0.5 min-h-11 border-b-4 px-2.5 py-2 font-display text-base font-bold whitespace-nowrap transition-colors sm:px-4 sm:text-lg ${
                selected
                  ? "border-forest text-ink"
                  : "border-transparent text-ink-soft hover:text-ink"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${base}-panel-${tab.id}`}
          aria-labelledby={`${base}-tab-${tab.id}`}
          hidden={tab.id !== active}
          className="min-w-0"
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
