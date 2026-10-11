# Behind the scenes: 2026-10-11

## Decisions
- **Invite-only login** (`shouldCreateUser: false`): review found that anyone could sign up and spend OpenAI credits through extraction.
- **Service role used server-side only, and only after ownership checks:** the user's own token loads the document and checks the path prefix before any admin write.
- **Drop-all-policies loop in migrations:** Postgres combines policies with OR, so unknown pre-existing prod policies could have kept tables open (#6, #7).
- **Atomic quota (`claim_extraction_slot`):** an advisory lock per user, with separate per-kind limits: rate confirmations 20/hr and 100/day, receipts 30/hr and 150/day. Receipt reads never use up the rate-con quota.
- **Per-stop time zones** (`us_state_tz`, falling back to the browser's zone): appointment times were first read as UTC, then in the browser's zone, which is wrong when the stop is in another state.
- **HEIC → JPEG in the browser, downscaled to 2000px:** iPhone photos, OpenAI image limits, and the 10 MB storage and ~4.5 MB request-body limits.
- **RPM = Σ rate / Σ total_miles** over loads with miles. A weighted total, not an average of per-load RPMs, and loads without miles are left out.

## How it was built
Team: Sam (PM), Alex and Casey (developers), Taylor (review/QA).

Flow: build → static review (pass/fail with file:line bugs) → fixes → re-review → Marc runs the SQL migrations in Supabase → merge.

- [#1](https://github.com/fstrucks/tms-app/pull/1) Magic-link login + RLS: fixes went through four rounds of review (callback flow, size limits, invite-only).
- [#2](https://github.com/fstrucks/tms-app/pull/2) AI rate con extraction: the cost/abuse finding led to quotas, the service-role write and generic errors.
- [#3](https://github.com/fstrucks/tms-app/pull/3) HEIC/HEIF → JPEG.
- [#4](https://github.com/fstrucks/tms-app/pull/4) Loads + create load from rate con: smoke-test risks noted (status/enum values, time zones).
- [#5](https://github.com/fstrucks/tms-app/pull/5) Profiles trigger: already applied in prod, documented after the fact.
- [#6](https://github.com/fstrucks/tms-app/pull/6) Expenses: the first review FAILed on surviving policies and rollback; passed after fixes.
- [#7](https://github.com/fstrucks/tms-app/pull/7) Mileage/RPM: FAIL on policies, a concurrency race and numeric types; passed after fixes.
- [#8](https://github.com/fstrucks/tms-app/pull/8), [#9](https://github.com/fstrucks/tms-app/pull/9) Time zones: browser zone first, then per-stop state zones.
- [#10](https://github.com/fstrucks/tms-app/pull/10) Receipt camera: downscaling and checks before save added after review.
- [#12](https://github.com/fstrucks/tms-app/pull/12) Receipt auto-fill: per-kind quota migration and the 4.5 MB body cap added after review.

## Chat highlights
- **Sam:** "Start with the code review now." / "Please report back with pass/fail and any bugs."
- **Alex** (relayed by Sam): "nothing has been tested against live Supabase yet."
- **Taylor:** "PR #6 code review: FAIL, but the fixes are small."
- **Taylor:** "PR #12 at ba58ac6: PASS, and safe to deploy in either order, though migrating first is best."
