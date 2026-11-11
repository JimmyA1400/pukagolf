"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * A wait between texts, so "Send another code" can't be tapped into a stream
 * of SMS. Every text costs money and counts against the project's hourly
 * allowance, which is shared by everyone signing up.
 *
 * This is manners, not a lock: someone calling Supabase directly skips it.
 * The real limits are Supabase Auth's own (docs/security-review.md).
 */
export const TEXT_COOLDOWN_SECONDS = 60;

export function secondsLeft(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 1000));
}

export function useCooldown(seconds = TEXT_COOLDOWN_SECONDS) {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (until === 0) return;

    const tick = () => {
      const at = Date.now();
      setNow(at);
      if (at >= until) clearInterval(timer);
    };
    const timer = setInterval(tick, 1000);
    tick();

    return () => clearInterval(timer);
  }, [until]);

  const start = useCallback(() => {
    const at = Date.now();
    setNow(at);
    setUntil(at + seconds * 1000);
  }, [seconds]);

  return { left: until === 0 ? 0 : secondsLeft(until, now), start };
}
