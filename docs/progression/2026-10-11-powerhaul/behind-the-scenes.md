# Behind the scenes: 2026-10-11 PowerHaul TMS

## Decisions
- **Name: PowerHaul TMS**, chosen by Marc. The UI rebrand shipped in [#21](https://github.com/fstrucks/tms-app/pull/21), with docs in [#20](https://github.com/fstrucks/tms-app/pull/20).
- **Separate Take photo and Choose file on /documents:** with the long MIME + extension accept list, Android Chrome offered only the camera. A capture-less `accept="application/pdf,image/*"` input brings back the Files/PDF option, and a separate `capture="environment"` input keeps one-tap camera. Since `image/*` lets more types through the picker, the type check moved to pick time ([#22](https://github.com/fstrucks/tms-app/pull/22)).
- **Show times in the stop's zone via `stops.timezone`:** times were shown in the viewer's zone. The zone is now stored per stop (backfilled from `TZ:` notes) and used for display ([#18](https://github.com/fstrucks/tms-app/pull/18)).

## How it was built
- Same flow as before: build → static review → fixes → re-review → Marc runs SQL → merge.
- [#18](https://github.com/fstrucks/tms-app/pull/18): static review PASS. Migration 0680 had to run before the UI that selects the column; merged.
- [#19](https://github.com/fstrucks/tms-app/pull/19): static review PASS (minor nits); merged.
- [#22](https://github.com/fstrucks/tms-app/pull/22): built after Marc's Android test found Choose file offered only the camera. Review PASS; merged. Marc's retest is pending.
- [#21](https://github.com/fstrucks/tms-app/pull/21) and [#20](https://github.com/fstrucks/tms-app/pull/20): rebrand and docs. Review PASS; the only conflict was CHANGELOG.md, resolved at merge.

## Chat highlights
- Taylor (#18 review): "PASS, with one deploy-order rule… run 0680 in SQL Editor before merging."
- Taylor (#19 review): "The empty state shows only after a successful fetch."
- Taylor (Android picker): "There is no `capture` attribute… so `capture` isn't what limits the picker to the camera."
