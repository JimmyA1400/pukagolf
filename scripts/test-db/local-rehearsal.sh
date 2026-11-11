#!/usr/bin/env bash
#
# A copy of a database backup in Docker on this computer, to rehearse
# migrations against before they go anywhere near Supabase.
#
#   scripts/test-db/local-rehearsal.sh "<backup folder>" [migration.sql ...]
#
# Starts (or restarts, empty) a container called pukagolf-rehearsal from
# Supabase's own Postgres image, loads the backup's schema and its public
# data, checks every public table's row count against the counts taken from
# live with that backup, then applies each migration given, in order, each
# as one transaction, as the same "postgres" role Supabase runs them as.
#
# Supabase's own auth tables are left out of the data: the image ships an
# older shape of them than a hosted project has. Nothing in public depends on
# their rows to load, and the comparison covers public tables only.
#
# Listens on 127.0.0.1:54329 only, password "rehearsal". Throwaway by design:
# `docker rm -f pukagolf-rehearsal` removes it.

set -euo pipefail
export MSYS_NO_PATHCONV=1

backup="${1:?Give the backup folder, e.g. Documents/PukaGolf backups/<date>}"
shift
# Git Bash on Windows: docker needs C:/..., not /c/..., with path conversion off.
here="$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))"
image="public.ecr.aws/supabase/postgres:17.11.0.011"
name="pukagolf-rehearsal"

for file in schema.sql data.sql live-counts.txt; do
  [ -f "$backup/$file" ] || { echo "$backup has no $file" >&2; exit 1; }
done

docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" -e POSTGRES_PASSWORD=rehearsal \
  -p 127.0.0.1:54329:5432 "$image" >/dev/null

for _ in $(seq 1 60); do
  docker exec "$name" pg_isready -U postgres -h localhost >/dev/null 2>&1 && break
  sleep 2
done

as_admin() { docker exec -i "$name" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

docker exec "$name" mkdir -p /work
docker cp "$backup/schema.sql" "$name:/work/schema.sql"
docker cp "$backup/data.sql" "$name:/work/data.sql"
docker cp "$here/row-counts.sql" "$name:/work/row-counts.sql"

echo "Loading the backup..."
# The image grants anon and authenticated everything new in public by
# default. A dump only records how each object differs from a plain one, so
# loaded with those defaults on, a function live has locked to service_role
# (make_admin, rebuild_scoring_ring) would come out callable by anyone, and
# every permission test after it would be testing a more open database than
# live. The load runs as supabase_admin, whose defaults these are, so they are
# off for the load and back on after it; postgres's own come back from the
# dump's ALTER DEFAULT PRIVILEGES lines.
defaults() {
  for role in postgres supabase_admin; do
    for kind in functions tables sequences; do
      echo "alter default privileges for role $role in schema public $1 all on $kind $2 anon, authenticated, service_role;"
    done
  done
}
defaults revoke from | as_admin
as_admin -f /work/schema.sql >/dev/null
defaults grant to | grep supabase_admin | as_admin

# The image's auth.users predates phone sign-in; a hosted project's has these,
# and functions such as owner_league_overview read them.
as_admin -c "alter table auth.users
               add column if not exists phone text,
               add column if not exists phone_confirmed_at timestamptz"

# Public COPY blocks and sequence positions only.
docker exec "$name" sh -c "awk 'BEGIN{keep=1} /^COPY /{keep = (\$2 ~ /^\"public\"\\./)} keep{print} /^\\\\\\.\$/{keep=1}' /work/data.sql | grep -v \"setval('\\\"auth\" > /work/data-public.sql"
as_admin -c "SET session_replication_role = replica" -f /work/data-public.sql >/dev/null

as_admin -At -f /work/row-counts.sql | grep -v '^auth\.' > /tmp/rehearsal-counts.txt
grep -v '^auth\.' "$backup/live-counts.txt" | tr -d '\r' | sed '/^$/d' > /tmp/rehearsal-live.txt
if ! diff /tmp/rehearsal-live.txt /tmp/rehearsal-counts.txt; then
  echo "The local copy doesn't match the backup's counts from live." >&2
  exit 1
fi
echo "Local copy matches live ($(wc -l < /tmp/rehearsal-counts.txt) public tables)."

for migration in "$@"; do
  echo "Applying $(basename "$migration")..."
  docker cp "$migration" "$name:/work/migration.sql"
  docker exec "$name" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
    --single-transaction -q -f /work/migration.sql >/dev/null
done

echo "Ready: $name on 127.0.0.1:54329."
