#!/usr/bin/env bash
#
# Run supabase/tests/club_isolation.sql against the local rehearsal copy.
#
#   scripts/test-db/local-rehearsal.sh "<backup folder>" supabase/migrations/00*.sql
#   scripts/test-db/local-isolation-tests.sh
#
# The tests roll themselves back, so this can run any number of times against
# the same copy. Exits non-zero, with the failing checks listed, if any fail.

set -euo pipefail
export MSYS_NO_PATHCONV=1

tests="$(cd "$(dirname "$0")/../../supabase/tests" && (pwd -W 2>/dev/null || pwd))"
name="pukagolf-rehearsal"

docker exec "$name" mkdir -p /work/tests
docker cp "$tests/test_valley.sql" "$name:/work/tests/test_valley.sql"
docker cp "$tests/club_isolation.sql" "$name:/work/tests/club_isolation.sql"

docker exec "$name" psql -U postgres -d postgres --no-psqlrc -q \
  -f /work/tests/club_isolation.sql 2>&1 \
  | grep -v '^ check *$\|^-*$\|^ *$\|^(1 row)$\|^ *[0-9]* rows\? *$'
