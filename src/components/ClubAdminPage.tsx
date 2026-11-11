"use client";

import Link from "next/link";

import { ClubAdmin } from "@/components/ClubAdmin";
import { ClubAuditLog } from "@/components/admin/ClubAuditLog";
import { LeagueAdmin } from "@/components/LeagueAdmin";
import { useClub } from "@/lib/club";

export function ClubAdminPage() {
  const { club, href } = useClub();

  if (club.role !== "admin") {
    return (
      <main className="mx-auto w-full max-w-md p-8 text-center font-mono text-sm text-ink-soft">
        <p>This page is for {club.name}&apos;s admins.</p>
        <Link href={href("/league")} className="mt-3 inline-block underline">
          Back to the league
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl space-y-10 p-5 sm:p-8">
      <header>
        <Link href={href("/league")} className="font-mono text-xs underline">
          ← The league
        </Link>
        <p className="meta mt-2">Admin</p>
        <h1 className="font-display text-3xl font-bold tracking-tight">{club.name}</h1>
        <p className="mt-1 font-mono text-xs text-ink-soft">
          Members, staff and leagues. Every change is written to the audit log.
        </p>
      </header>

      <ClubAdmin />

      {/* The league picked at the top of the page: its weeks, rules and season. */}
      <LeagueAdmin />

      <ClubAuditLog />
    </main>
  );
}
