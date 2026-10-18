# Rate con miles: Planned vs Actual (PR A)

- **Planned miles** (`loads.total_miles`): typed > rate con > calculated route miles (PR B).
  `loads.miles_source` records which: `typed`, `rate_con`, `calculated`. A grey note under Planned shows it.
- **Actual miles**: the sum of the load's mileage log entries, shown next to Planned. Marc's decision (Oct 18,
  "I like seeing both"): logged miles no longer overwrite Planned.
- Rate con reader: `total_miles` = total or loaded trip miles printed by the broker (Miles / Distance field,
  linehaul or per-mile line). Miles inside driving directions are ignored. null when not printed.
- Copied on "Create load" and on a re-run only while Planned is empty (or was calculated). Typed always wins.
- Migration `20261018000300_load_miles_source.sql` (not applied by the PR): adds `miles_source`, stops the
  0600 trigger from copying the log sum into `total_miles`. Before it runs the app still works: writes retry
  without `miles_source`, the note is inferred, and the old trigger still copies the log total (a hint says so).
- To go back to "log replaces planned": re-run `20261010000600_mileage.sql`.
