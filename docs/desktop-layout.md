# Desktop layout & nav plan (design only)

Status: draft for review. No code in this PR.
Inputs: Jordan's UX audit (screenshots in `/workspace/ux-audit/` at 590px and 1024px; not committed) and the current `app/layout.js`, `app/components/AppNav.js`, `app/globals.css` and pages.
Today the nav switches at a single breakpoint (`max-width: 640px` in `globals.css`): a header on desktop (inner max width 960px), a bottom tab bar on phones. Each page sets its own narrow `maxWidth`.

## 1. Goals / problems found in the audit

| # | Problem | Where | Fix (section) |
|---|---------|-------|---------------|
| 1 | Content sits in a narrow ~370–620px column on desktop, with most of the screen empty | /loads, /documents, /expenses, /mileage at 1024px | Shared container (2) |
| 2 | Dashboard grid is inconsistent: the summary card is full width, weekly cards are 3-up with uneven heights | /dashboard | Grid rules (2, 4) |
| 3 | Top tabs are ~13px text; the effective tap targets are under 44px | AppNav header | Nav spec (2) |
| 4 | No account menu; sign-out lives inside page content (home) | / | Account menu (2) |
| 5 | `/docs` returns 404 (the tab says "Docs", the route is `/documents`) | routing | Redirect (2) |
| 6 | No sortable tables; lists are cards only | loads, expenses, mileage | `Table` (2, 4) |
| 7 | Cards don't look clickable (no hover, no chevron, no focus ring) | /loads | `Card` interactive variant (2) |
| 8 | Status pill is weak (small pale lavender for every status) | /loads | `StatusPill` (3) |
| 9 | Docs upload needs a separate "Upload" click after picking a file; no progress | /documents | Auto-upload + progress (3) |
| 10 | Empty states are blank or a single gray line | most lists, dashboard with 0 data | `EmptyState` (2) |
| 11 | Delete sits right next to Edit. Mileage and expenses already use `window.confirm`, but the buttons are adjacent and the confirm is an easy misclick | /expenses, /mileage rows | (4) |
| 12 | Mileage dropdowns look disabled (gray fill, low contrast) | /mileage | Casey (4) |
| 13 | Weekly dashboard cards wrap labels at ~590px ("All-in RPM (revenue ÷ logged loaded + deadhead)") | /dashboard | (4) |

Goals: use the desktop width without hurting mobile; one shell and one set of components so every page looks the same; 44px minimum targets everywhere; no feature changes beyond the ones listed.

## 2. Layout shell (owner: Alex)

### Breakpoints (FINAL)
| Name | Width | Nav | Columns |
|------|-------|-----|---------|
| mobile | < 640px | bottom tab bar + slim top bar (kept as today, plus account button) | 1 |
| tablet (narrow) | 640–767px | bottom tab bar + slim top bar (same as mobile) | 1, with 2-up card grids |
| tablet | 768–1023px | top nav | 1, with 2-up card grids |
| desktop | ≥ 1024px | top nav | list+detail splits, 3-up grids, tables |

Layout breakpoints stay 640 / 1024 (gutters, grids, Table vs Card). The **nav** has its own switch at **768px**: the full top nav needs ~650px of content width and has only 592px at 640 (640 − 2×24 gutters). So bottom tabs + slim top bar are kept up to 767px, and the top nav shows at ≥768px. (Rejected: a short "PH" brand + icon-only account button at 640–1023. It's more variants for little gain.)

CSS is mobile-first: `@media (min-width: 640px)`, `@media (min-width: 768px)` (nav only) and `@media (min-width: 1024px)`. Any remaining `max-width` rules use `.98` values (`max-width: 639.98px`, `767.98px`, `1023.98px`). The shell PR changes today's `max-width: 640px` rules in `globals.css` to `max-width: 639.98px`, so exactly one layout applies at 640, and moves the nav switch to `767.98px` / `768px`, so exactly one nav renders at every width.
**Test (shell PR):** at 639, 640, 641, 767, 768 and 769px exactly one nav is visible (bottom tabs ≤767, top nav ≥768) and the other is `display:none`. Gutters and grids switch between 639 and 640. `--nav-h: 60px` (used by sticky Save bars) follows the nav, so it applies up to 767.98px, not just under 640.

### Container
- `max-width: 1120px`, centered, applied once in the shell (`<main class="container">`). Pages stop setting their own `maxWidth`. Forms inside may cap their own width at 640px.
- Gutters: 16px mobile, 24px tablet, 32px desktop. Vertical page padding 16 / 24 / 32px.
- Grid gap: 12px mobile, 16px tablet and desktop.
- The header's inner width matches the container (1120px, same gutters).

### Top nav (≥ 768px)
- Height 56px, sticky, white, bottom border.
- Left: "PowerHaul TMS" brand → `/`. Then tabs: Dashboard, Loads, Documents, Expenses, Mileage. The label changes from "Docs" to "Documents" on desktop.
- Tab text 15px (0.9375rem), weight 500 (600 when active), a 2px active underline, each link ≥ 44px high with ≥ 12px horizontal padding.
- Right: **account menu**. A button shows the user's initial/avatar plus the email, truncated at ≥1024px. It opens a menu with the email (read-only), Settings (later, hidden for now) and **Sign out**. Keyboard behaviour matches `UploadMenu`: Esc, arrows, Home/End, close on focus-out.
- Sign-out is removed from page content (home).

### Mobile bottom tabs
- Kept below 768px (mobile and narrow tablet): 6 tabs, 60px bar, safe-area padding, hidden while the keyboard is open.
- Account and Sign out on mobile: a small account button in a slim mobile top bar (brand + account, 48px), using the same menu component.

### Targets
- Every interactive element is ≥ 44×44px (buttons, tabs, row actions, pill filters). Icon buttons get 44px hit areas even if the icon is smaller.

### Routing
- `/docs` → `/documents`: a permanent redirect in `next.config.js` (`redirects()`, `permanent: true`). Also `/doc` and `/document`.

### Shared components (`app/components/ui/`)
| Component | Props | Notes |
|-----------|-------|-------|
| `PageHeader` | `title`, `subtitle?`, `actions?` (node), `back?` ({href,label}) | h1 22px/26px desktop; actions right-aligned, wrap under the title on mobile |
| `Card` | `title?`, `actions?`, `href?` / `onClick?`, `padding?` ('sm'\|'md'), `children` | interactive when `href`/`onClick` is set: hover shadow, chevron, focus ring, whole card clickable |
| `Table` | `columns` [{key,label,align?,sortable?,render?,width?}], `rows`, `rowKey`, `sort?` {key,dir}, `onSort?`, `onRowClick?`, `empty?` (node), `loading?` | ≥1024px only; below that, pages render `Card` lists. The switch is **CSS only**: the page renders both, the table in `.only-desktop` and the cards in `.only-mobile`. `globals.css` sets `display:none` on the inactive one (`.only-desktop{display:none} @media (min-width:1024px){.only-desktop{display:revert}.only-mobile{display:none}}`). No JS width check, so there's no flash on load, and the hidden copy is `display:none`, so screen readers and the tab order skip it. Sort state is kept in the URL query (`?sort=date&dir=desc`) |
| `StatusPill` | `status`, `size?` ('sm'\|'md') | colours in section 3; unknown status → gray |
| `EmptyState` | `icon?`, `title`, `body?`, `action?` ({label, href \| onClick}) | used for "no loads yet → Upload a rate con", etc. |
| `ConfirmButton` | `label`, `confirmLabel`, `onConfirm`, `danger?` | inline two-step confirm (first click → "Delete? Yes / Cancel"); replaces `window.confirm` |
| `AccountMenu` | `email`, `onSignOut` | used in both navs |

Styling stays inline/CSS-variable based (no new UI library). Tokens go in `globals.css`: colours, radius 10px, spacing scale 4/8/12/16/24/32.

## 3. Loads & Documents (owner: Alex)

### Loads
- **Desktop (≥1024): list + detail split.** Left: the loads list at 380px, either a `Table` (Load #, Broker, Pickup → Delivery, Rate, Status, Date), sortable, or compact cards.
  - **Stop times** show in **each stop's own timezone** (`stops.timezone`) with the zone abbreviation, e.g. "Oct 15, 8:00 AM EDT" for Atlanta and "Oct 16, 9:00 AM CDT" for Chicago (`Intl.DateTimeFormat` with `timeZone` + `timeZoneName: 'short'`; if there's no `timezone`, fall back to the browser zone with its abbreviation).
  - **Sorting** by pickup/delivery uses the absolute timestamp `appointment_start` (timestamptz), never the formatted local text or the browser-local time. Right: the selected load's detail. The URL stays `/loads/[id]`, so links and refresh work; `/loads` with nothing selected shows an `EmptyState` on the right.
- Tablet and mobile: the list is full width; tapping a load opens `/loads/[id]` as today.
- List cards use the `Card` interactive variant.
- The load detail redesign (stops, map) comes after the scanner; see section 6. This PR only moves the existing detail into the right pane.

### Status pill styling
Solid, readable pills, 12px semibold text, with a text label (colour is never the only signal):

| Status | Background / text |
|--------|-------------------|
| booked | blue-100 #dbeafe / #1e40af |
| dispatched | indigo-100 #e0e7ff / #3730a3 |
| in_transit | amber-100 #fef3c7 / #92400e |
| delivered | green-100 #dcfce7 / #166534 |
| invoiced | teal-100 #ccfbf1 / #115e59 |
| paid | green-700 #15803d / #fff |
| cancelled / canceled / tonu / void | gray-100 #f3f4f6 / #4b5563, label "Cancelled", "TONU" or "Void" |
| unknown | gray outline |

Labels are human text ("In transit", not `in_transit`).

Contrast (WCAG AA, ≥ 4.5:1 for 12px text), checked: booked 7.2, dispatched 8.1, in_transit 6.4, delivered 6.5, invoiced 6.7, paid 5.0 (was #16a34a = 3.3, failed), cancelled 6.9, unknown (#4b5563 on white) 7.6. All pass.

### Documents: auto-upload
- After a file is picked through `UploadMenu` (Take photo / Photo library / Files-PDF), the upload **starts immediately**, with no separate Upload button.
- A row appears at the top of the list with the filename, a **progress bar** (percentage) and a Cancel button. HEIC is converted to JPEG first, and the bar shows "Converting…".
- **Same checks as today's upload** for both the picker and drag-and-drop, run before anything is sent:
  - PDF, JPEG, PNG, WebP, HEIC/HEIF only (checked by MIME type and extension). **SVG is rejected**, as is anything else.
  - **10 MB cap** (matches the storage bucket limit), checked after HEIC conversion.
  - HEIC → JPEG with downscale (same as the current converter).
  - **One file at a time**: a multi-file drop takes the first file and says "One file at a time". A drop during an upload is refused until it finishes.
- **Cancel** aborts the XHR and **removes any partial storage object** (`storage.remove([path])`). No `documents` row is created until the upload succeeds.
- **Accessibility:** progress and the result are announced in an `aria-live="polite"` region ("Uploading rate-con.pdf, 40%" at 25% steps, then "Uploaded" or the error). The bar is `role="progressbar"` with `aria-valuenow`.
- On success the row becomes the document card. For rate cons it offers "Extract details" (the current flow). On failure it shows an inline error with Retry.
- Doc type is chosen *before* picking (a segmented control defaulting to Rate confirmation) and can be changed afterwards on the card.
- Progress: supabase-js `upload()` doesn't report progress, so we'd use a signed upload URL (`createSignedUploadUrl`) and an XHR PUT with `upload.onprogress`. No DB or SQL changes.
- Desktop: the documents list is a `Table` (Name, Type, Load, Uploaded), with drag-and-drop onto the page as an extra upload path.

## 4. Expenses & Mileage desktop (owner: Casey for UI)

**Handoff:** the mileage **page UI** (`app/mileage/page.js` and the presentational parts of `app/lib/mileage.js`, i.e. the dropdowns, empty states, table and row actions) is handed to **Casey**. **Alex keeps the mileage logic, data and RPM calculations** (queries, entry types/sources, loaded/deadhead/personal totals, RPM in `app/lib/dashboard.js`). Casey also owns the expenses page UI. Casey uses the shared components from section 2.

Cross-cutting rules for these pages (agreed now):
- **Sortable tables** at ≥1024px with the `Table` component: Expenses (Date, Vendor, Category, Load, Amount) and Mileage (Date, Type, Miles, Load). Default sort is date descending, saved in the URL.
- **Delete with confirm, away from Edit**: Edit stays the primary row action. Delete moves to a row overflow menu (⋯), or to the far right with ≥ 24px gap, and uses `ConfirmButton` (the inline two-step) instead of `window.confirm`. On the edit form, Delete sits bottom-left in red and Save bottom-right.
- **Dashboard weekly cards** (Alex, since the data is Alex's): fixed grid of 1 column below 640, 2 at 640–1023, 3 at ≥1024 (explicit counts via the `.week-grid` class in 4.6, not `auto-fill`). Short labels ("All-in RPM") with the long formula moved to a tooltip/footnote, numbers right-aligned with `tabular-nums`, and no wrapping at 590px. The summary card spans the full width with the chart on the left and totals on the right at ≥1024px.

### Conventions for 4.1–4.6 (Casey)
- Styles stay inline objects (`const s = {...}` per file), same tokens as today: border `#e5e7eb`, input border `#d1d5db`, text `#111827`, labels `#374151`, muted `#6b7280`, primary `#2563eb`, danger `#b91c1c` / `#fecaca`, radius 8 (controls) and 12 (cards). Breakpoint-dependent rules (which inline styles can't express) go in `globals.css` as a few small classes (`.only-desktop`, `.only-mobile`, `.week-grid`), mobile-first with the section 2 breakpoints (640 / 1024).
- Money is always `fmtMoney` from `app/lib/money.js` (2 decimals, `—` for empty); RPM is `fmtPerMile`. `LoadExpenses.js` keeps importing `fmtMoney` via the `lib/loads` re-export (same function); new code imports from `lib/money` directly. Number columns use `fontVariantNumeric: 'tabular-nums'` and right alignment.
- Table vs cards: the `Table` component renders at ≥1024px only (section 2). Below 1024 the existing card/row lists stay (the mobile card list is unchanged under 640; 640–1023 uses the same cards inside the wider container). Both are rendered from the same sorted array, so sort order matches across sizes.
- **Dates:** `expense_date` and `entry_date` are DATE columns (`YYYY-MM-DD`) and are shown exactly as stored, no time zone conversion. Parse as local parts: `const [y,m,d] = str.split('-').map(Number); new Date(y, m - 1, d)` (or format the parts directly); never `new Date(str)` (that's UTC midnight and shows the previous day in Pacific). Sorting compares the strings. `fmtEntryDate` already appends `T00:00:00` (local); the shared helper replaces that and the expenses list's date formatting.
- No data, query or SQL changes. Sorting is client-side on the rows already fetched (both pages fetch the full list today).

### 4.1 Expenses desktop layout
**Layout (≥1024):** two columns inside the 1120 container: the Add/Edit expense form on the left, sticky at `top: 72px` (nav 56 + 16), the list on the right (`minmax(0, 1fr)`). Form width: **340px at 1024–1279px**, 380px at ≥1280px (`.split` class in `globals.css`). 640–1023 and <640: single column as today (form, then list), with the form capped at 640px.

**Toolbar above the table:** Load filter (existing select) left; filtered total `fmtMoney(sumAmounts(shown))` right; the existing "Rate · Net" line stays under it when a load is selected.

**Table columns** (`Table` props):
| key | label | align | sortable | render |
|-----|-------|-------|----------|--------|
| expense_date | Date | left, **fixed 112px** | yes | `Oct 12, 2026`, shown exactly as stored (see Dates below) |
| description | Vendor / description | left | yes (case-insensitive, empty last) | ellipsis at 1 line, full text in `title`; **below 1280px Category shows as a muted second line here** |
| category | Category | left | yes | capitalized; column hidden below 1280px (Category sort stays available via a "Sort by" select in the toolbar below 1280px) |
| load | Load | left | yes (by label, "—" last) | link to `/loads/[id]` (stops row click) |
| amount | Amount | right, **fixed 120px** | yes (numeric) | `fmtMoney(x.amount)`, tabular-nums |
| actions | (sr-only "Actions") | right, **fixed 104px** (two 44px buttons + gap) | no | Receipt icon button (if any) + ⋯ menu |

- **Width at 1024:** content ≈ 960 − 340 form − 16 gap ≈ 600px for the table: Date 112 + Amount 120 + actions 104 leaves ≈ 264px for Vendor (+Category line) and Load. Table uses `tableLayout: 'fixed'`. **Fallback:** the table sits in a wrapper `<div role="region" aria-label="Expenses table" tabIndex={0} style={{ overflowX: 'auto' }}>` so if it still doesn't fit (long load labels, 200% zoom) it scrolls sideways inside its own box, never the page, and keyboard users can focus it and scroll with arrow keys.
- **Default sort:** `expense_date` desc, tie-break `created_at` desc. Sort state in the URL (`?sort=amount&dir=asc`), merged with the existing `?load=` param (not replacing it). Unknown keys fall back to the default.
- **Keyboard / a11y:** sortable headers are `<th aria-sort="ascending|descending|none">` containing a real `<button>` (≥44px high) labelled e.g. "Amount, sort ascending"; Enter/Space toggles (first click: desc for date/amount, asc for text; second click flips). Only the active column has a non-`none` `aria-sort`; a ▲/▼ glyph is `aria-hidden`. A polite live region announces "Sorted by Amount, ascending". Row click = Edit (loads it into the left form and moves focus to the form heading); rows are not tab stops themselves, the Edit item in the ⋯ menu is the keyboard path, plus the Load link.
- **Footer row:** "N expenses · Total {fmtMoney}" right-aligned under Amount.

**Delete moved away from Edit:**
- Table: actions cell is Receipt + **⋯ menu** (44×44, `aria-label="More actions for {category} {amount} on {date}"`, `aria-haspopup="menu"`). Menu items: Edit, View receipt (if any), a divider, **Delete** in danger style (`color: '#b91c1c'`). Menu keyboard matches `UploadMenu` (Esc, arrows, Home/End, close on focus-out, focus returns to the ⋯ button).
- Mobile/tablet cards: the row becomes `Edit` (primary) + `Receipt` on the left, and Delete is removed from the card row; it lives in the **edit form** only.
- Edit form (all sizes): when editing, the bottom bar shows **Delete bottom-left** (danger outline: `border: '1px solid #fecaca', color: '#b91c1c', background: '#fff'`), Cancel edit and **Save bottom-right**. ≥24px between Delete and any other button.
- Confirm: choosing **Delete** in the ⋯ menu closes the menu and turns that row's actions cell into an inline confirm: "Delete expense? **Cancel** / **Yes, delete**" (Yes in danger style), with **focus on Cancel**. Esc or Cancel restores the actions and returns focus to the row's ⋯ button. The same inline confirm is used for Delete in the edit form. This is the `ConfirmButton` pattern from section 2 and **replaces `window.confirm('Delete this expense?')`** (today's confirm); if the shell PR hasn't shipped `ConfirmButton` yet, the page builds the same two-step locally rather than keeping `window.confirm`. After delete, focus moves to the next row (or the list heading) and the status line says "Expense deleted." The receipt-cleanup logic in `remove()` is unchanged.

**Acceptance criteria**
- At 1280 and 1024: form left + table right, no horizontal page scroll; every column header sorts; URL reflects sort and survives refresh; `?load=` still filters.
- At <1024: the card list renders (same order as the table would), no table markup in the DOM tab order.
- No Delete button sits next to Edit anywhere; Delete is reachable in ≤2 actions and always confirmed.
- All amounts use `fmtMoney`; totals equal the sum of visible rows.

**Test checklist**
- [ ] Desktop 1280: sort each column both ways; reload keeps sort; filter by load + sort together; totals and Rate/Net correct.
- [ ] Desktop 1024: same as above; long vendor text ellipsizes, tooltip shows full text; the form stays sticky while scrolling the list.
- [ ] Tablet (768, portrait iPad 820): single column, cards, Edit/Receipt on the card, Delete only inside the edit form.
- [ ] Phone (375 and 390, Android Chrome + iOS Safari): unchanged card list; sticky Save still clears the bottom tab bar; Delete in edit form confirms and returns focus.
- [ ] Narrow tablet (~700px): sticky Save bar clears the bottom tabs; the ⋯ menu isn't clipped at the right edge.
- [ ] Keyboard only: Tab to headers, Enter/Space sorts, screen reader reads `aria-sort`; open ⋯ with Enter, arrow to Delete, Esc closes and returns focus; delete via keyboard and confirm.
- [ ] Cancelling the confirm leaves the row and the receipt intact; Delete from ⋯ → focus on Cancel; Esc returns focus to ⋯.
- [ ] 1024 exactly: form is 340px, Category shows under Vendor, no page-level horizontal scroll; at 200% zoom the table region scrolls sideways and is reachable with Tab + arrows.
- [ ] Dates (Pacific user, device TZ America/Los_Angeles): an expense dated 2026-10-12 shows "Oct 12, 2026" in the table, card and edit form (not Oct 11), also late evening PT; same for a mileage entry.

### 4.2 Mileage desktop layout
UI only; queries, `SOURCES`, totals and RPM stay with Alex (section 4 handoff). The presentational pieces in `app/lib/mileage.js` (`EntryRow`, the `MileageForm` styles) are restyled, not re-wired.

**Layout (≥1024):** stats strip on top (This week / This month as today, plus they sit 2-up at ≥640); below it, the Add miles form on the left (sticky; 340px at 1024–1279, 380px at ≥1280) and the Entries table on the right. <1024: single column as today.

**Table columns:**
| key | label | align | sortable | render |
|-----|-------|-------|----------|--------|
| entry_date | Date | left, fixed 112px | yes | `fmtEntryDate`, as stored (see Dates) |
| source | Type | left | yes | capitalized (Loaded / Deadhead / Personal / Other), with a small neutral text tag, not colour-only |
| miles | Miles | right | yes | `fmtMiles`, tabular-nums |
| odometer | Odometer | right | no | `start → end` or `—` |
| load | Load | left | yes ("—" last) | `Load #123 · Broker` link |
| notes | Notes | left | no | 1-line ellipsis + `title` |
| actions | (sr-only) | right, fixed 60px | no | ⋯ menu |

- **Width at 1024:** Miles fixed 96px; below 1280px Odometer and Notes collapse into a muted second line under Load. Same scrollable `role="region"` `tabIndex={0}` wrapper ("Mileage table") as the fallback.
- **Default sort:** `entry_date` desc, tie-break `created_at` desc; URL `?sort=&dir=`. Same header button / `aria-sort` / live-region rules as 4.1.
- **Footer row:** "N entries · {fmtMiles(total)}" for the visible rows.
- **Delete away from Edit:** mileage has no Edit today, and this doc adds none (no feature changes). Delete leaves the always-visible row: on desktop it's the only item in the ⋯ menu (danger style); on cards (<1024) `EntryRow` gets a ⋯ button at the far right (44×44) with Delete inside, replacing the bare red button. Choosing Delete closes the menu and turns the row's actions into "Delete entry? **Cancel** / **Yes, delete**" with focus on Cancel; Esc/Cancel restores and returns focus to ⋯; after delete focus moves to the next row. This replaces `window.confirm('Delete this entry?')`. If an Edit is added later, it becomes the first menu item.

**Acceptance criteria**
- Same as 4.1 for layout, sort, URL and confirm; stats and totals values identical to today (no logic change).
- `EntryRow` has no visible Delete button; delete is ⋯ → Delete → confirm.

**Test checklist**
- [ ] Desktop 1280 / 1024: sort Date, Type, Miles, Load both ways; reload keeps sort; odometer entries show start → end.
- [ ] Tablet 768: cards, stats 2-up, ⋯ menu works with touch.
- [ ] Narrow tablet (~700px): sticky "Add miles" clears the bottom tabs; the ⋯ menu isn't clipped at the right edge.
- [ ] Phone 375/390: list unchanged except ⋯ replaces Delete; menu does not clip off-screen at the right edge; sticky "Add miles" clears the tab bar.
- [ ] Keyboard: headers sort, ⋯ opens/closes with Enter/Esc, focus returns; delete confirm via keyboard.
- [ ] Delete from ⋯ → "Delete entry? Cancel / Yes, delete" with focus on Cancel; Esc restores and returns focus to ⋯.
- [ ] Pacific user: entry dated 2026-10-12 shows Oct 12 at 1024, 1280 and on the phone card.
- [ ] Totals on /mileage and the dashboard unchanged before/after (spot-check one week).

### 4.3 Mileage dropdowns: look enabled
Cause: the mileage `st.input` (lib/mileage.js) sets no `background` or `color`, so Android Chrome and some desktop themes draw the native gray "disabled-looking" fill on `<select>` (Type, Load). The expenses `s.input` already sets `background: '#fff'`.

One shared style for every `<select>` on Expenses and Mileage (Type, LoadPicker select, Expenses category/load/filter):
- `background: '#fff'`, `color: '#111827'`, `border: '1px solid #6b7280'` (≈4.8:1 against white, meets WCAG 1.4.11's 3:1 for control boundaries; `#9ca3af` is only ≈2.5:1 and `#d1d5db` less), `colorScheme: 'light'` (so a dark phone/OS theme can't render the native gray/dark select), radius 8, `fontSize: '1rem'` (prevents iOS zoom), `minHeight: 44`, `padding: '0.55rem 2.25rem 0.55rem 0.6rem'`.
- `appearance: 'none'` / `WebkitAppearance: 'none'` with a chevron as an inline SVG data-URI `backgroundImage` (`#374151`, 12px, `backgroundPosition: 'right 0.75rem center'`, `backgroundRepeat: 'no-repeat'`).
- Placeholder option ("No load", "All loads") shows in `#374151`, not gray-on-gray.
- Focus: `globals.css` rule `select:focus-visible, input:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }` (inline styles can't do `:focus-visible`).
- Real disabled state is distinct: `background: '#f3f4f6'`, `color: '#9ca3af'`, `cursor: 'not-allowed'`, chevron hidden.
- The Odometer / Miles toggle (`st.tab`) gets `minHeight: 44` and `aria-pressed`.

**Acceptance criteria:** enabled selects are white with a dark chevron on Android Chrome, iOS Safari, desktop Chrome/Safari/Firefox; text contrast ≥ 4.5:1, border ≥ 3:1; visible focus ring on keyboard focus only; disabled clearly differs.

**Test checklist**
- [ ] Phone with dark theme on (Marc's Android + iPhone): Type and Load selects stay white (`color-scheme: light`), chevron visible, native picker still opens.
- [ ] Desktop 1280/1024 Chrome, Safari, Firefox: same look; dark-mode OS setting doesn't turn them gray.
- [ ] Tablet: same.
- [ ] Keyboard: Tab shows the blue ring; arrow keys change value; Space/Alt+↓ opens.
- [ ] Disabled (while saving) looks disabled.

### 4.4 Empty states
Use `EmptyState` (section 2: `icon?`, `title`, `body?`, `action?`). Centered in the list area, `padding: '2rem 1rem'`, title 1rem/600 `#111827`, body `#6b7280`, action is a 44px primary or outline button. Loading and error states (`Loading`, `LoadError`) stay as they are; empty only shows after a successful fetch.

| Where | Condition | Title | Body | Action |
|-------|-----------|-------|------|--------|
| /expenses list | no expenses at all | No expenses yet | Add fuel, tolls, repairs and more. Snap a receipt and we'll fill it in. | "Add expense" → focus the Amount field (desktop) / scroll to form (mobile) |
| /expenses filtered | a load is selected, 0 rows | No expenses for this load | — | "Add expense for this load" (presets the load) + "Show all loads" (clears filter) |
| /mileage list | no entries | No miles logged yet | Log loaded and deadhead miles to see your all-in RPM. | "Add miles" → focus Date field |
| Load page `LoadExpenses` | 0 expenses | keep the compact rows; change "Expenses (0)" line to "No expenses yet" with the existing "Add / view" link | — | existing link |
| Dashboard week with no data | (Alex's page; suggestion) | Nothing this week | — | "Add expense" / "Log miles" links |

Empty states never show `$0.00` as if it were data (per the LoadExpenses rule). The filtered total shows `fmtMoney(0)` only when a filter returned 0 rows and the empty state is visible.

**Acceptance criteria:** each list has its own copy and a working action; the action is keyboard reachable and moves focus as described; nothing renders "empty" during loading or after an error.

**Test checklist**
- [ ] New test account (no data): /expenses, /mileage show the states at 1280, 1024, tablet, phone.
- [ ] Filter to a load with no expenses: filtered state + both actions work.
- [ ] Throttle network: Loading shows first, never the empty state; offline: error, not empty.
- [ ] Keyboard: Tab to the action, Enter moves focus to the form field.

### 4.5 Receipt upload on desktop
- Keep the current flow (pick via `UploadMenu` → convert/downscale → `/api/extract-receipt` auto-fill → saved on Save). It already starts reading right after the pick, so there's no extra Upload click to remove.
- **Drop zone (≥1024):** the receipt fieldset gets a dashed `2px dashed #6b7280` outline, the text "Drop a receipt here", and a **real "Choose file" button inside the zone** (the existing `UploadMenu`), so the zone is never the only path. Drag-over state: `#2563eb` outline + `#eff6ff` fill.
- **Same checks as upload for drop and paste**, run through one `acceptReceipt(file)` before `pickFile()`: PDF, JPEG, PNG, WebP or HEIC/HEIF only (by MIME and extension); **SVG rejected**; **10 MB max**; HEIC converted to JPEG and downscaled exactly as the picker path does; **one file at a time** (a multi-file drop/paste is rejected with "Drop one receipt at a time"). PDF is saved with no AI (section 5).
- **Paste:** listens only while the receipt form is in use (focus is inside the expense form or the zone); takes the clipboard *file* only if it passes `acceptReceipt`; if the clipboard has no file (plain text) the handler returns without `preventDefault`, so pasting text into Vendor/Amount always works.
- **Drops outside the zone:** while /expenses is mounted, `window` `dragover` and `drop` listeners call `preventDefault()` so a missed drop never opens the file in the browser tab (removed on unmount).
- **Announcements:** an `aria-live="polite"` region in the fieldset announces "Receipt added: name.jpg, reading…", the auto-fill result, or the error ("That file type isn't supported", "File is over 10 MB").
- Reuse section 3's progress row only if Alex's signed-URL XHR helper lands; no change to receipt storage paths or the orphan cleanup in `submit()`/`remove()`.
- **Acceptance:** drop and paste behave identically to the picker for allowed files and reject the rest with an announced message; text paste unaffected; stray drops never navigate.
- **Test checklist:**
  - [ ] Desktop 1280/1024: drop JPG, PNG, WebP, HEIC (converted), PDF (no AI); drop SVG, a 12 MB JPG, and two files → each rejected with the right message.
  - [ ] Drop a file on the nav/table (outside the zone): page doesn't navigate.
  - [ ] Paste a screenshot with focus in the form → added; paste text into Vendor → text pastes; paste with focus outside the form → nothing happens.
  - [ ] Keyboard: Tab to "Choose file" inside the zone; screen reader hears the live-region messages.
  - [ ] Tablet/phone: no drop zone styling change; picker flow unchanged.

### 4.6 Dashboard weekly card wrapping at ~590px
Ownership: Alex owns the data and label wording (section 4). This is the layout spec Casey proposes for it.
- Cause: `s.grid` uses `repeat(auto-fill, minmax(260px, 1fr))`. At 590px (≈558 content) that makes two ~273px columns, and the stat rows (`display:flex; justify-content:space-between`) let the long labels wrap under or into the values.
- Grid: a `globals.css` class instead of `auto-fill`, so column counts match section 2 exactly: `.week-grid { display:grid; gap:12px; grid-template-columns: minmax(0,1fr); } @media (min-width:640px){ .week-grid{ gap:16px; grid-template-columns: repeat(2, minmax(0,1fr)); } } @media (min-width:1024px){ .week-grid{ grid-template-columns: repeat(3, minmax(0,1fr)); } }`. Cards `align-items: stretch` so heights match per row.
- Stat row: `display:grid; grid-template-columns: minmax(0,1fr) auto; column-gap: 0.75rem; align-items: baseline`. Label may wrap to 2 lines max inside its own column; value `whiteSpace:'nowrap'`, right-aligned, tabular-nums, via `fmtMoney` / `fmtPerMile`.
- Labels shortened (confirmed by Alex): "Loaded RPM", "All-in RPM", "Loaded / deadhead"; the formulas move to a footnote under the card ("All-in RPM = revenue ÷ (loaded + deadhead logged miles)") or an info button (44px, `aria-describedby`), not hover-only.

**Acceptance criteria:** at 590 one column, no label overlaps or pushes a value; at 640–1023 two columns; ≥1024 three; values never wrap.

**Test checklist**
- [ ] 590, 375, 640, 768, 1024, 1280: column count 1/1/2/2/3/3; no overlaps; equal heights per row.
- [ ] Largest values ($99,999.99, 9,999 mi): still one line.
- [ ] Phone with 200% text size: labels wrap within their column, values intact.
- [ ] Keyboard/screen reader: formula footnote/info reachable and read.

### Notes / questions from Casey (not added to section 7)
- Section 7 Q4 (delete pattern) already covers the confirm choice; 4.1/4.2 follow whatever Marc picks.
- Mileage has no Edit; adding one would be a feature change, so it's left out. Raise later only if Marc wants it.

## 5. Shared `app/lib/docTypes.js`

One list, used by the documents page, `UploadMenu` callers, the vault checklist, maintenance (Casey) and email-forward. **No DB change**: `documents.doc_type` is free text, with no check constraint in the migrations.

Existing values in the repo: `rate_confirmation` (migration 0720 backfills NULL to this) and `receipt` (expense receipts, shown on /expenses only). Legacy NULL is treated as `rate_confirmation`.

```js
// shape only, not final code
{ id, label, category: 'load' | 'company' | 'vehicle', accept: 'pdf+image' | 'image' | 'pdf', extract?: 'rate_con' | 'receipt' }
```

| id | label | category | accept | notes |
|----|-------|----------|--------|-------|
| rate_confirmation | Rate confirmation | load | pdf+image | AI extraction (`/api/extract`) |
| bol | Bill of lading | load | pdf+image | scanner target |
| pod | Proof of delivery | load | pdf+image | scanner target |
| lumper_receipt | Lumper receipt | load | pdf+image | |
| receipt | Expense receipt | load | image (pdf allowed, no AI) | `/api/extract-receipt`; lives on /expenses |
| other_load_doc | Other load document | load | pdf+image | |
| w9 | W-9 | company | pdf | vault |
| coi | Certificate of insurance | company | pdf | vault |
| mc_authority | MC authority letter | company | pdf | vault |
| other_company_doc | Other company document | company | pdf+image | vault |
| vehicle_title | Vehicle title | vehicle | pdf+image | |
| vehicle_registration | Registration | vehicle | pdf+image | |
| vehicle_insurance | Vehicle insurance | vehicle | pdf+image | |
| bill_of_sale | Bill of sale | vehicle | pdf+image | |
| maintenance_invoice | Maintenance invoice | vehicle | pdf+image | Casey's maintenance v1 |
| dot_inspection | DOT inspection | vehicle | pdf+image | |
| other_vehicle_doc | Other vehicle document | vehicle | pdf+image | |

Only `rate_confirmation` and `receipt` exist in data today. The load/company rows other than those two are proposals for the vault/scanner work (see section 7). `accept` is a hint for the UI. `UploadMenu` keeps Files/PDF as `application/pdf` only (the Android camera issue), and images come from Take photo / Photo library.

## 6. Sequencing
1. **Shell PR (Alex):** breakpoints, container, top nav + account menu, mobile account button, `/docs` redirect, the shared `ui/` components, `docTypes.js`. Pages adopt the container with no other visual changes.
2. **Casey starts** expenses/mileage UI once the shell PR lands, **or** as soon as Marc approves the section 2 numbers, building against the component props above.
3. **Alex:** loads list+detail split, StatusPill, documents auto-upload + progress, dashboard grid fix.
4. **BOL/POD scanner ships before the load detail redesign** (stops/map, Uber Freight reference). The redesign then builds on the scanner's document entry points.
5. The core order is unchanged: email-forward + vault, maintenance v1, ELD.

## 7. Open questions for Marc
1. **Container width.** A) 1120px (recommended) B) 1280px for wider tables C) full width with side gutters.
2. **Desktop loads view.** A) list + detail split (recommended) B) a full-width sortable table that opens the detail page C) both, with a toggle.
3. **Mobile sign-out location.** A) a slim top bar with an account button (recommended) B) a 7th "Account" bottom tab C) on the Home page only.
4. **Delete pattern.** A) inline two-step confirm (recommended) B) a modal dialog C) an "Undo" toast after delete (soft delete; needs a DB change).
5. **Status colours.** A) approve the table in section 3 (all ≥ 4.5:1) B) a neutral palette: gray pills for everything except a colour accent for delivered/paid, with the text label carrying the meaning C) your brand colours (send the hex values; we'll check contrast).
6. **Nav label.** "Documents" on desktop and "Docs" on mobile (recommended), or "Docs" everywhere.
7. **Extra doc types** (BOL, POD, lumper, W-9, COI, MC letter). A) add them now in `docTypes.js` B) add them only when the scanner/vault ship.
