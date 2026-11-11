"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { lastTried, mostTries, unsentCount, type PendingScore } from "@/lib/score-queue";

/** How long what Send now did stays up. */
const SENT_FOR_MS = 4_000;
/** How long "All scores sent" stays up once the last one goes: over the card for 4s was too long. */
const ALL_SENT_FOR_MS = 2_000;

function subscribe(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** Whether the phone thinks it has a connection. Assumed so on the server. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}

/**
 * Scores still on this phone, said plainly and kept in view while scrolling:
 * a golfer walking off the 9th needs to know three holes never went up.
 *
 * With no signal, or when sends keep failing, it also tells the group to keep
 * a paper card, so a flat battery can't cost anyone their round.
 */
export function UnsentScores({
  pending,
  onSendNow,
  nothingToScore = false,
}: {
  pending: readonly PendingScore[];
  /** Resolves once the try is over, to how many hole scores are still waiting. */
  onSendNow: () => Promise<number> | void;
  /** Every card this phone keeps is signed or locked: no signal changes nothing. */
  nothingToScore?: boolean;
}) {
  const online = useOnline();
  // What "Send now" did, said for a few seconds: with no signal it can't do
  // anything, and a button that seems dead gets pressed again and again.
  const [tried, setTried] = useState<string | null>(null);
  useEffect(() => {
    if (!tried) return;
    const timer = window.setTimeout(() => setTried(null), SENT_FOR_MS);
    return () => window.clearTimeout(timer);
  }, [tried]);
  // "Still no signal" is out of date the moment the signal is back.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (online) setTried((now) => (now && /no signal/i.test(now) ? null : now));
  }, [online]);
  const count = unsentCount(pending);
  const tries = mostTries(pending);
  const lastTry = lastTried(pending);
  // When the signal last came back. Tries made with no signal don't mean
  // PukaGolf isn't answering: counting them flashed "Can't reach PukaGolf"
  // for a moment on every reconnect.
  const [onlineSince, setOnlineSince] = useState(0);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (online) setOnlineSince(Date.now());
  }, [online]);
  // Signal, but the sends get no answer: PukaGolf itself isn't answering.
  const unreachable = online && tries > 0 && (lastTry ?? 0) > onlineSince;
  // The paper-card advice, behind a "?" so the bar stays one line. There
  // from the start: waiting for a second failed try put it up 7s late.
  const [why, setWhy] = useState(false);

  // The bar's own height kept free at the foot of the page, and as scroll
  // padding, so it never sits over the last thing on the page or a field
  // scrolled into view. Two to five lines of it once covered Save.
  const barRef = useRef<HTMLElement | null>(null);
  const [barHeight, setBarHeight] = useState(0);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const measure = () => setBarHeight(bar.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  });
  useEffect(() => {
    const root = document.documentElement;
    root.style.scrollPaddingBottom = barHeight > 0 ? `${barHeight + 8}px` : "";
    return () => {
      root.style.scrollPaddingBottom = "";
    };
  }, [barHeight]);

  // The bar moves to the top of the screen while the bottom has something
  // under it that mustn't be hidden: the pad's Save, a card being edited,
  // the box being typed in. Scrolled so Save sat at the bottom edge, the bar
  // covered all of it.
  const [edge, setEdge] = useState<"top" | "bottom">("bottom");
  useEffect(() => {
    if (barHeight === 0) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      const band = barHeight + 4;
      const view = window.innerHeight;
      // How much each thing matters, from data-keep-clear: "2" for Save, the
      // box being typed in above everything. The bar goes to whichever edge
      // hides the least of it: with the name band at the top and Save at the
      // bottom, it stayed put over one of them.
      const keep: { box: DOMRect; weight: number }[] = [
        ...document.querySelectorAll<HTMLElement>("[data-keep-clear]"),
      ].map((el) => ({ box: el.getBoundingClientRect(), weight: Number(el.dataset.keepClear) || 1 }));
      // The box being typed in, the 19th Hole's post box as much as a score.
      const focused = document.activeElement;
      if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) {
        keep.push({ box: focused.getBoundingClientRect(), weight: 3 });
      }
      const shown = keep.filter(({ box }) => box.height > 0);
      const hidden = (under: (r: DOMRect) => boolean) =>
        Math.max(0, ...shown.filter(({ box }) => under(box)).map(({ weight }) => weight));
      const atBottom = hidden((r) => r.bottom > view - band && r.top < view);
      const atTop = hidden((r) => r.top < band && r.bottom > 0);
      setEdge(atBottom > atTop ? "top" : atTop > atBottom ? "bottom" : (now) => now);
    };
    const soon = () => {
      if (!frame) frame = window.requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", soon, { passive: true });
    window.addEventListener("resize", soon);
    document.addEventListener("focusin", soon);
    // The page changing under a still bar: a "not sent yet" line pushing the
    // editor down after an offline change moved nothing until a scroll.
    const page = new ResizeObserver(soon);
    page.observe(document.body);
    return () => {
      page.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", soon);
      window.removeEventListener("resize", soon);
      document.removeEventListener("focusin", soon);
    };
  }, [barHeight]);

  // "All scores sent", briefly, when the last waiting score goes up.
  const [justSent, setJustSent] = useState(false);
  const before = useRef(count);
  useEffect(() => {
    const had = before.current;
    before.current = count;
    if (had > 0 && count === 0) {
      setJustSent(true);
      const timer = window.setTimeout(() => setJustSent(false), ALL_SENT_FOR_MS);
      return () => window.clearTimeout(timer);
    }
  }, [count]);

  // Pinned to the bottom of the screen, one line high: kept at the top it
  // sat over the hole number, par and name it was warning about. It goes up
  // only while the bottom has something it would hide.
  const bar = `fixed inset-x-0 z-40 mx-auto max-w-3xl bg-card px-3 py-1.5 ${
    edge === "top"
      ? "top-0 border-b-2 shadow-[0_2px_8px_rgba(0,0,0,0.12)]"
      : "bottom-0 border-t-2 shadow-[0_-2px_8px_rgba(0,0,0,0.12)]"
  }`;

  if (count === 0 && (online || nothingToScore)) {
    // A hole entered while this is up replaces it with the count instead.
    // Moved out of the way like the bar: at the bottom it sat over the card's
    // HCP row.
    return justSent ? (
      <p
        ref={(el) => {
          barRef.current = el;
        }}
        role="status"
        data-edge={edge}
        className={`${bar} border-forest font-mono text-sm text-forest`}
      >
        All scores sent.
      </p>
    ) : null;
  }

  // Beside the count, only what it doesn't already say: what Send now did,
  // or that the signal is fine and PukaGolf isn't answering.
  const state =
    tried ??
    (unreachable
      ? `Can't reach PukaGolf${lastTry ? ` (tried ${clock(lastTry)})` : ""}. They go when it answers.`
      : count === 0
        ? "Scores you enter wait here for signal."
        : null);

  return (
    <>
      {/* Room at the foot of the page, as tall as the bar itself. */}
      <div
        aria-hidden
        style={{ height: barHeight || undefined }}
        className={barHeight ? "" : "h-14"}
      />
      <section
        ref={barRef}
        aria-label="Scores not sent"
        data-edge={edge}
        className={`${bar} border-clay`}
      >
        <div className="flex items-center justify-between gap-2">
          {/* Never cut short: "That try failed: couldn't reach…" lost its end
              at 375px. The bar grows a line instead. */}
          <p
            role="status"
            className="min-w-0 font-mono text-xs leading-snug"
          >
            <span className="font-display text-sm font-bold text-clay">
              {count > 0
                ? `${count} ${count === 1 ? "hole score" : "hole scores"} not sent yet`
                : "No signal"}
            </span>
            {state && ` ${state}`}
          </p>
          <button
            type="button"
            aria-expanded={why}
            aria-label="Keep a paper card?"
            onClick={() => setWhy((open) => !open)}
            className="min-h-11 min-w-11 shrink-0 border border-clay font-mono text-sm font-bold text-clay"
          >
            ?
          </button>
          {count > 0 && (
            <button
              type="button"
              onClick={async () => {
                // With no signal there's nothing to try, and it says so as a
                // failed try: "Still no signal" read as if nothing happened.
                if (!online) {
                  setTried(`That try failed at ${clock(Date.now())}: no signal. They go by themselves when it's back.`);
                  return;
                }
                setTried("Sending\u2026");
                const left = await onSendNow();
                // A try that left scores waiting says so, and when: not
                // "Sending…", then the same line as before, as if nothing failed.
                if (typeof left === "number") {
                  setTried(
                    left === 0
                      ? null
                      : navigator.onLine
                        ? `That try failed at ${clock(Date.now())}: no answer from PukaGolf. Trying again by itself.`
                        : `That try failed at ${clock(Date.now())}: no signal. They go by themselves when it's back.`,
                  );
                }
              }}
              className="min-h-11 shrink-0 bg-forest-deep px-3 font-mono text-xs tracking-wider text-cream uppercase"
            >
              Send now
            </button>
          )}
        </div>

        {why && (
          <p className="pb-1 font-mono text-[11px] leading-snug font-bold">
            Keep a paper card as well until this clears. If a phone dies, finish
            the round on paper and take the card to the pro shop staff.
          </p>
        )}
      </section>
    </>
  );
}

/** "9:47 PM". */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
