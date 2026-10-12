#!/bin/bash
# SQL tests for parse_us_address / us_state_tz against a LOCAL throwaway Postgres only.
# Never point this at Supabase: it drops and recreates the public schema.
# Defaults: socket /tmp, port 54329, user postgres. Loads us_state_tz (0660) + the latest parse_us_address.
set -e
export PGHOST=${PGHOST:-/tmp} PGPORT=${PGPORT:-54329} PGUSER=${PGUSER:-postgres}
cd "$(dirname "$0")"
M=../../supabase/migrations
ext() { awk -v n="$2" '$0 ~ "create or replace function public\\."n"\\(" {p=1} p {print} p && /^\$\$;/ {exit}' "$1"; }
{ echo "drop schema if exists public cascade; create schema public;"
  ext $M/20261010000660_stop_timezones.sql us_state_tz
  ext $M/20261012000730_address_parser_fixes.sql parse_us_address
} | PGOPTIONS="-c client_min_messages=warning" psql -q -X -v ON_ERROR_STOP=1
psql -q -X -v ON_ERROR_STOP=1 -f test_address_tz.sql
