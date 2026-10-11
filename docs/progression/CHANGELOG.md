# PowerHaul TMS — Changelog

Notable changes to PowerHaul TMS, newest first. Dates are merge dates (UTC) from GitHub.

## 2026-10-11
- Named the app PowerHaul TMS (Marc)
- [#15](https://github.com/fstrucks/tms-app/pull/15) docs: progression log (README, CHANGELOG, 2026-10-11 current state)
- [#18](https://github.com/fstrucks/tms-app/pull/18) Store stop timezone and show appointments in each stop's zone (migration 0680), merge 7de008b; `/loads` labels City, ST; home drops duplicate links
- [#16](https://github.com/fstrucks/tms-app/pull/16) Receipt parsing follow-ups (months, all date candidates, logs, limits, single decode)
- [#14](https://github.com/fstrucks/tms-app/pull/14) Mobile UI polish: shared nav, tap targets, sticky actions
- [#17](https://github.com/fstrucks/tms-app/pull/17) Hardened stop address parsing (`parse_us_address`: newlines, trailing country, last valid state + ZIP) so stop time zones resolve; home page shows signed-in state, sign out and app links.
- [#11](https://github.com/fstrucks/tms-app/pull/11) Weekly dashboard (`/dashboard`): booked revenue (excludes cancelled/canceled/TONU/void), load-mile and logged-mile RPM, expenses by category, net; 4/8-week toggle; inline SVG charts.
- [#13](https://github.com/fstrucks/tms-app/pull/13) Receipt date & category fix: the model returns the printed date, the server parses it, and there's no fallback to today. Explicit category rules (e.g. parking → tolls).
- [#12](https://github.com/fstrucks/tms-app/pull/12) Expenses: AI auto-fill from receipt photos
- [#10](https://github.com/fstrucks/tms-app/pull/10) Expenses: Take photo / Upload file for receipts

## 2026-10-10
- [#6](https://github.com/fstrucks/tms-app/pull/6) Expenses: add/list/edit, receipts, per-load total & net
- [#5](https://github.com/fstrucks/tms-app/pull/5) Migration: profiles backfill + on_auth_user_created trigger
- [#7](https://github.com/fstrucks/tms-app/pull/7) Mileage tracking + rate per mile
- [#8](https://github.com/fstrucks/tms-app/pull/8) Fix: interpret rate con appointment times in the user's timezone
- [#9](https://github.com/fstrucks/tms-app/pull/9) Per-stop time zones for rate con appointments (merge after #8)
- [#4](https://github.com/fstrucks/tms-app/pull/4) Loads list + detail pages, Create load from rate con
- [#3](https://github.com/fstrucks/tms-app/pull/3) Convert iPhone HEIC/HEIF photos to JPEG before upload
- [#2](https://github.com/fstrucks/tms-app/pull/2) AI rate confirmation extraction
- [#1](https://github.com/fstrucks/tms-app/pull/1) Magic-link login + documents table RLS
- Commit 2a047f6 (direct to main, no PR): Add rate confirmation upload page (/documents) with Supabase Storage + documents bucket migration

## Open (not merged)
- [#19](https://github.com/fstrucks/tms-app/pull/19) Loading/error states (no false empty lists) + 2-decimal money
