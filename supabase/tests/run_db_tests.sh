#!/usr/bin/env bash
# Runs migrations + seed + security tests against a throwaway database on a plain PostgreSQL server.
# Usage: PGHOST=/tmp/pgtest PGPORT=54329 PGUSER=postgres ./run_db_tests.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DB=ratib_test

psql -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists $DB" -c "create database $DB"
run() { psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$1"; }

run tests/00_supabase_stubs.sql
for m in migrations/*.sql; do echo "applying $m"; run "$m"; done
echo "applying seed.sql"; run seed.sql
echo "applying seed.sql a second time (must be re-runnable)"; run seed.sql
for f in tests/01_rls_tests.sql tests/02_staff_tests.sql; do
  psql -v ON_ERROR_STOP=1 -d "$DB" -f "$f" 2>&1 | grep -E "PASS|FAIL|ERROR|ALL .*CHECKS" | sed 's/^psql:[^ ]* //' || true
done
