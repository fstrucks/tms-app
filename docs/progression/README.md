# Progression log

A visual record of how the TMS app evolves, one milestone at a time.

## Layout

```
docs/progression/
  README.md          this file
  CHANGELOG.md       short dated changelog (one line per PR)
  YYYY-MM-DD-<milestone>/
    notes.md         what changed, PR links, known gaps
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

## Data rules

- **Test data only.** Use a test account and made-up loads, receipts and amounts.
- **Never show real broker names, rates, customer/shipper addresses, emails or load numbers.** If a real value can't be avoided, blur it before committing.
- Don't capture the browser URL bar or devtools if they show tokens, project URLs or keys.

## Adding a milestone

1. Create `docs/progression/YYYY-MM-DD-<milestone>/`.
2. Add screenshots and `notes.md` (copy the structure from the latest milestone).
3. Add a line to `CHANGELOG.md` for any new PRs.
