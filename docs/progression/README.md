# Progression log

A visual record of how the TMS app evolves, one milestone at a time.

## Layout

```
docs/progression/
  README.md          this file
  CHANGELOG.md       short dated changelog (one line per PR)
  YYYY-MM-DD-<milestone>/
    notes.md         what changed, PR links, known gaps, screenshots
    behind-the-scenes.md  decisions, how it was built, chat highlights
    *.png            screenshots
```

- **One folder per milestone**, named `YYYY-MM-DD-<milestone>` (UTC date, kebab-case milestone), e.g. `2026-10-11-current-state`.
- **Screenshots:** PNG. Take a desktop shot at 1280px wide, and a mobile shot at 375px wide where the layout differs or matters (forms, camera/receipt flows, lists).
  Suggested names: `<page>-desktop.png`, `<page>-mobile.png` (e.g. `expenses-mobile.png`).
- **notes.md** in each folder covers:
  - What changed since the previous milestone
  - PR links
  - Known gaps / follow-ups
  - A Screenshots section listing each image with a one-line caption

## behind-the-scenes.md
Short, with exactly three sections:
- **Decisions:** what we chose and why (one line each, with the PR).
- **How it was built:** the PR flow (build → QA pass/fail → fixes → Marc runs SQL → merge), with PR links.
- **Chat highlights:** a few short quotes (under ~25 words) attributed to the agent (Sam, Alex, Casey, Taylor), taken only from real review or handoff messages.

## Template
Copy into a new milestone folder (also in `_template/`).

`notes.md`:
```
# YYYY-MM-DD: <milestone>
## What changed
## PRs
## Known gaps
## Screenshots
```

`behind-the-scenes.md`:
```
# Behind the scenes: YYYY-MM-DD
## Decisions
- **<decision>:** why (PR #)
## How it was built
- [#N](link) one line
## Chat highlights
- **<Agent>:** "<short quote>"
```

## Data rules

- **Test data only.** Use a test account and made-up loads, receipts and amounts.
- **Never show real broker names, rates, customer/shipper addresses, emails or load numbers.** If a real value can't be avoided, blur it before committing.
- No keys, tokens, emails, real broker names or rates, or Marc's private remarks. Paraphrase; no long logs or raw transcripts.
- Don't capture the browser URL bar or devtools if they show tokens, project URLs or keys.

## Adding a milestone

1. Create `docs/progression/YYYY-MM-DD-<milestone>/`.
2. Add screenshots, `notes.md` and `behind-the-scenes.md` (from `_template/`).
3. Add a line to `CHANGELOG.md` for any new PRs.
