"use client";

export type RsvpStatus = "in" | "out" | "undecided";

const CHOICES: { value: RsvpStatus; label: string }[] = [
  { value: "in", label: "In" },
  { value: "out", label: "Out" },
  { value: "undecided", label: "Undecided" },
];

/**
 * In / Out / Undecided for one round.
 *
 * Locked once the admin's cut-off passes: pairings are built from these
 * answers, so a player dropping out afterwards would leave a group short with
 * nobody knowing. The message says what to do instead of just disabling.
 */
export function RsvpControl({
  value,
  lockedAt,
  onChange,
  disabled = false,
}: {
  value: RsvpStatus | null;
  /** ISO timestamp after which players can no longer change their answer. */
  lockedAt?: string | null;
  onChange: (status: RsvpStatus) => void;
  disabled?: boolean;
}) {
  const locked = lockedAt !== null && lockedAt !== undefined
    ? new Date(lockedAt) <= new Date()
    : false;
  const frozen = locked || disabled;

  return (
    <div>
      <div className="flex gap-1.5" role="group" aria-label="Attendance">
        {CHOICES.map((choice) => {
          const active = value === choice.value;

          return (
            <button
              key={choice.value}
              type="button"
              disabled={frozen}
              aria-pressed={active}
              onClick={() => onChange(choice.value)}
              className={`min-h-11 flex-1 border px-2 font-mono text-xs tracking-wider uppercase transition-colors ${
                active
                  ? "border-forest bg-forest text-cream"
                  : "border-hairline bg-cream hover:border-forest"
              } ${frozen ? "cursor-not-allowed opacity-50" : ""}`}
            >
              {choice.label}
            </button>
          );
        })}
      </div>

      {locked && (
        <p className="mt-1.5 font-mono text-xs text-clay">
          Pairings are set. Contact the admin to change this.
        </p>
      )}
    </div>
  );
}
