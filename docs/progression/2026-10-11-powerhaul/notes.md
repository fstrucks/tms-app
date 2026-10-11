# 2026-10-11: PowerHaul TMS milestone

## What changed
- **Stop time zones in the UI** ([#18](https://github.com/fstrucks/tms-app/pull/18)): new `stops.timezone` column (migration 0680). Appointment times on the loads list and load detail now show in the stop's own zone, falling back to the browser zone.
- **Loading states + money** ([#19](https://github.com/fstrucks/tms-app/pull/19)): skeletons while loading, an empty state only after a successful fetch, generic errors with Retry, a session check before fetching, and one money formatter that always shows 2 decimals.
- **Android picker split** ([#22](https://github.com/fstrucks/tms-app/pull/22)): /documents now has **Take photo** (camera) and **Choose file** (PDF or image, no `capture`). Unsupported types are rejected as soon as a file is picked.
- **Rebrand** ([#21](https://github.com/fstrucks/tms-app/pull/21)): PowerHaul TMS in the tab title, nav, home and login headings, README, and a PH favicon.
- **Docs** ([#20](https://github.com/fstrucks/tms-app/pull/20)): progression log renamed to PowerHaul TMS.

## PRs
- [#18](https://github.com/fstrucks/tms-app/pull/18) Store stop timezone and show appointments in each stop's zone
- [#19](https://github.com/fstrucks/tms-app/pull/19) Loading/error states (no false empty lists) + 2-decimal money
- [#20](https://github.com/fstrucks/tms-app/pull/20) docs: name the app PowerHaul TMS
- [#21](https://github.com/fstrucks/tms-app/pull/21) Branding: PowerHaul TMS
- [#22](https://github.com/fstrucks/tms-app/pull/22) Fix Android file picker on /documents (Take photo + Choose file)

## Verified
- TEST-1002 load detail: pickup 8:00 AM EDT, delivery 2:00 PM EDT (stop zone, not the viewer's).
- Browser tab title "PowerHaul TMS" with the PH favicon.
- Top nav doesn't wrap at ~768-800px.
- Mobile shows bottom tabs.

## Known gaps
- Load detail: the "Save" button next to Total miles wraps ("Sav" / "e").
- Dashboard label exposes the internal column name `loads.total_miles`.
- Android Choose file showing Files/PDF: pending Marc's retest after #22.
- Supabase magic-link email still uses the old name (Supabase dashboard setting, not code).

## Screenshots
Test account, fake data.
- [01-home.png](01-home.png): home with PowerHaul TMS branding.
- [02-documents.png](02-documents.png): /documents with rate confirmations.
- [03-loads.png](03-loads.png): loads list.
- [04-load-detail.png](04-load-detail.png): load detail.
- [05-mileage.png](05-mileage.png): mileage page.
- [06-expenses.png](06-expenses.png): expenses page.
- [07-dashboard.png](07-dashboard.png): weekly dashboard.
- [08-nav-768.png](08-nav-768.png): top nav at ~768px, no wrapping.
- [09-mobile-home.png](09-mobile-home.png): mobile home with bottom tabs.
- [10-mobile-loads.png](10-mobile-loads.png): mobile loads list.
- [11-load-detail-edt.png](11-load-detail-edt.png): TEST-1002 stop times in EDT (8:00 AM / 2:00 PM).
- [12-documents-pickers.png](12-documents-pickers.png): /documents Take photo and Choose file buttons.
