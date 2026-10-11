# 2026-10-11 — Current state

Snapshot of production (main at 8bf3771).

## Features in production
- **Sign-in:** invite-only magic link (no public signups). [#1](https://github.com/fstrucks/tms-app/pull/1)
- **Rate confirmations (/documents):** upload a PDF or photo to private storage under the user's own folder. iPhone HEIC photos are converted to JPEG in the browser. [#1](https://github.com/fstrucks/tms-app/pull/1), [#3](https://github.com/fstrucks/tms-app/pull/3), commit 2a047f6
- **AI extraction:** pulls broker, load #, refs, stops and rate from a rate con. Per-user quota, and the result is written server-side only. [#2](https://github.com/fstrucks/tms-app/pull/2)
- **Loads (/loads):** list and detail pages, plus "Create load from rate con" (load + pickup/delivery stops, linked document). [#4](https://github.com/fstrucks/tms-app/pull/4)
- **Appointment times:** interpreted in each stop's state time zone, falling back to the browser's zone. [#8](https://github.com/fstrucks/tms-app/pull/8), [#9](https://github.com/fstrucks/tms-app/pull/9)
- **Profiles:** a profile row is created automatically for every new user, and existing users were backfilled. [#5](https://github.com/fstrucks/tms-app/pull/5)
- **Mileage (/mileage):** odometer or miles entries, weekly/monthly totals. Loads keep total_miles and rate per mile up to date automatically. [#7](https://github.com/fstrucks/tms-app/pull/7)
- **Expenses (/expenses):** add/edit/delete with categories, optional load link and receipt, per-load total and net. [#6](https://github.com/fstrucks/tms-app/pull/6)
- **Receipt capture:** Take photo / Upload file, images downscaled to 2000px JPEG. [#10](https://github.com/fstrucks/tms-app/pull/10)
- **Receipt AI auto-fill:** fills only empty fields, with its own quota (30/hr, 150/day). [#12](https://github.com/fstrucks/tms-app/pull/12)
- **Security:** row-level security limits every table and storage path to the owner.

## Pending
- [#11](https://github.com/fstrucks/tms-app/pull/11) Weekly dashboard: merged 2026-10-11.
- [#13](https://github.com/fstrucks/tms-app/pull/13) Receipt auto-fill date/category fix: open. Until it merges, auto-fill can set the date to today or pick the wrong category (e.g. parking → fuel).

## Known gaps
- **Time zones:** a split-zone state uses its main zone (e.g. TX → Central, so El Paso is off by 1h; same for FL panhandle, west KY/TN, north ID, west ND/SD/NE/KS, Malheur OR, MI UP). Addresses without a parseable 2-letter state fall back to the browser's zone. US territories other than PR aren't mapped. Stops created before #8/#9 still have UTC-interpreted times.
- **Orphaned receipts:** replacing a receipt or deleting an expense leaves the old receipt row and file in storage. If linking fails, the receipt row is left in place (logged). A cleanup job isn't built yet.
- **Manual miles:** if a load's last mileage entry is deleted, total_miles becomes empty, wiping any value entered by hand before.
- **Schema drift:** some tables (loads, stops, expenses, mileage_entries, profiles) were created in the dashboard, not by migrations, so a fresh environment can't be rebuilt from the repo alone.
- **Receipt auto-fill:** PDFs can't be read. Each new photo uses one read from the quota.
- Android device testing partly done: file picker verified; orientation, auto-fill and layout checks pending.

## Known issues found in smoke test
- Atlanta, GA stop showing America/Chicago: fixed by [#17](https://github.com/fstrucks/tms-app/pull/17) for new loads (TEST-1002 verified America/New_York). Stops created earlier keep their old zone.
- Appointment times are shown in the viewer's zone instead of the stop's zone: fix pending in [#18](https://github.com/fstrucks/tms-app/pull/18).
- Home page showing "Sign in" while signed in: fixed by [#17](https://github.com/fstrucks/tms-app/pull/17).
- The expense form keeps the Load selection after saving.

## Device testing
- iPhone (Safari), tested by Marc on 2026-10-11: all checks passed: magic-link sign-in, receipt camera (rear camera, portrait/landscape orientation, library pick), receipt save/view, receipt auto-fill, rate con upload + extraction + create load, load stop times, mileage totals/RPM, mobile layout.
- Android (Chrome), tested by Marc on 2026-10-11: native file picker (Camera / Photos & videos) opens correctly from Rate Confirmations Choose File and Expenses Take photo / Upload file. Remaining Android checks (orientation, auto-fill, layout) pending.

## Screenshots
Desktop, 1280px, signed out (no test data visible).

- [01-home.png](01-home.png): signed-out home page, re-taken after #17/#14: shared top nav plus "Sign in".
- [02-login.png](02-login.png): magic-link sign-in.
- [03-documents-unauth.png](03-documents-unauth.png): /documents signed out, showing the in-page sign-in prompt (no redirect).
- [04-loads-unauth.png](04-loads-unauth.png): /loads signed out, showing the in-page sign-in prompt (no redirect).
- [05-expenses-unauth.png](05-expenses-unauth.png): /expenses signed out, showing the in-page sign-in prompt (no redirect).
- [06-mileage-unauth.png](06-mileage-unauth.png): /mileage signed out, showing the in-page sign-in prompt (no redirect).
- [07-dashboard-unauth.png](07-dashboard-unauth.png): /dashboard returns 404, because #11 isn't merged.

### Signed in (test account, fake data)
- [10-documents-uploaded.png](10-documents-uploaded.png): /documents right after upload, extraction running.
- [11-documents-extracted.png](11-documents-extracted.png): fields extracted from the rate con.
- [12-load-detail.png](12-load-detail.png): load detail for TEST-1001 (stops, miles, expenses, documents).
- [13-loads-list.png](13-loads-list.png): loads list.
- [14-load-mileage-rpm.png](14-load-mileage-rpm.png): load mileage and RPM ($2.56/mi on 780 mi).
- [15-mileage.png](15-mileage.png): mileage page with weekly/monthly totals.
- [16-expense-autofill.png](16-expense-autofill.png): expense receipt auto-fill.
- [17-expenses-list.png](17-expenses-list.png): expenses list.
- [18-home-signed-in.png](18-home-signed-in.png): home page, signed in.
- [19-mobile-documents.png](19-mobile-documents.png): mobile (~388px) /documents.
- [20-mobile-expenses.png](20-mobile-expenses.png): mobile (~388px) /expenses.

### Retest after #17 (test account, fake data)
- [21-home-signed-in.png](21-home-signed-in.png): home page signed in (signed-in state, sign out).
- [22-load-detail-ga.png](22-load-detail-ga.png): load detail TEST-1002 with the Atlanta, GA stop on America/New_York.

### Pending screenshots
- /dashboard via the PR #11 preview deployment
