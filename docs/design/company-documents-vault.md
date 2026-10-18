# Company Documents vault — design + wireframe

> **Status: DESIGN ONLY.** Wireframes and this doc only. No app code, no migration, no SQL run. Nothing is built until Marc approves (via Sam). Reviewer: Taylor.
> Idea approved by Marc on Oct 18, 2026 at 1:38 PM PT ("That's perfect"). This PR is for reviewing the layout and choosing the open picks in §7.

Wireframes (static HTML in `docs/wireframes/company-documents/`, PNGs rendered with headless Chrome):

| Screen | HTML | PNG |
|---|---|---|
| Company page, desktop 1280 | `desktop-company.html` | `desktop-company.png` |
| Company page, phone 390 | `phone-company.html` | `phone-company.png` |
| Documents tab after the move, phone 390 | `phone-documents-tab.html` | `phone-documents-tab.png` |
| Vault → packets → Send to broker, desktop | `packet-flow.html` | `packet-flow.png` |

## 1. What exists today (checked on `main` at 4a8fc35)

- **Doc types:** `app/lib/docTypes.js` `SCAN_DOC_TYPES` marks `w9`, `coi` and `mc_authority` as `company: true`. `isCompanyDocType()` only defaults the Scanner's Load picker to "No load" (`Scanner.js:285`). Company docs are otherwise ordinary rows in the `/documents` list.
- **Schema:** `documents` (`20261010000050`) has `id, user_id, load_id, truck_id, doc_type, file_path, original_filename, ai_extracted_data, created_at`. `doc_type` is **plain text with no check constraint**. There is no expiry column, no "current" flag and no version link. RLS is own rows (`user_id = auth.uid()`). Client insert and update grants cover only `load_id, truck_id, doc_type` (plus `user_id, file_path, original_filename` on insert).
- **Insurance:** `app/company/CompanyInsurance.js` (Company page) lists `insurance_policies` (`20261017001800`: coverage, limit, `effective_date`, `expiry_date`, `confirmed`, `document_id → documents`). Gap notes come from `coiGaps()` (`app/lib/coiGaps.js`), filtered by `companyGapNotes()`, plus `suggestedExpiredNotes()` (`app/lib/coiRequest.js`). "Upload COI" links to `/documents?type=coi`. The Suggest buttons list the 10 newest `doc_type = 'coi'` documents.
- **Broker send:** `app/api/packets/[id]/send/route.js` → `postmarkSend()` (`app/lib/packetSend.js`) attaches **only the filled packet PDF**. No company document is attached today.
- **Rate con upload:** it can auto-reclassify a COI (`documents/page.js:194`) and tells the user to open Company → Insurance.
- **Load delete:** `app/lib/loadDelete.js` can delete linked documents if the user opts in, so a company doc that was linked to a load could be deleted with that load.

## 2. The vault card (Company page)

- It's a new **Company documents** card between *Authorized signer* and *Insurance*. It always has 4 rows, in this order: **W-9, COI, MC Authority, NOA**. The header reads "N of 4 on file".
- Each row shows the status pill, upload date, expiry, **View**, and **Replace ▾**, or **Upload or scan ▾** when the doc is missing. Both buttons open the existing `UploadMenu` (Take photo · Photo library · Choose file · Scan document). The type is preset, and the load is always none.
- Statuses:
  - ✓ **On file** (green).
  - ⚠ **Expires within 30 days** or **check notes** (amber).
  - ✕ **Missing** or **expired** (red).
- **Expiry:**
  - COI: computed (see §3).
  - MC Authority: "No expiry". FMCSA operating authority doesn't expire; it's revoked instead.
  - W-9 and NOA: "No expiry".
- **Current version only.** Current = the newest upload of that type for the company. Older ones go under a collapsed **Earlier versions (n)** with View (and Delete via the existing ConfirmButton). Uploading a new file moves the old one down automatically.
- **Roles:** owner and management can upload, replace and delete, matching the Insurance write rule. Dispatchers and drivers can view. This is pick 2.
- **Phone (390):** each doc is a stacked card with full-width buttons, and the COI card holds its notes and earlier versions. **Desktop (≥1024):** a table inside the same 1120px shell, with callouts in the wireframe only.

## 3. Tie-in with CompanyInsurance

- The **COI expiry** is the earliest `expiry_date` among the *confirmed* `auto_liability` and `cargo` policies, computed with the same `day()` and `laToday()` logic. Nothing gets typed twice. If there's no confirmed policy, the row shows "Expiry not entered", with a link to Insurance.
- The **COI status** reuses the existing gap list. `coiGaps({ policies, profile, today })` → `companyGapNotes()` + `suggestedExpiredNotes()`.
  - Any `error` makes the status red (missing, below minimum, expired).
  - Any `warn` makes it amber (unconfirmed, no expiry, limit unknown), and so does expiry within 30 days.
  - No notes means green.
- The first note shows under the COI row with **"Go to Insurance ↓"**. The Insurance card keeps its full list unchanged.
- In the Insurance card, "Upload COI" opens the vault's COI upload instead of `/documents?type=coi`. "Suggest policies from …" defaults to the **current** COI, and earlier versions stay selectable.
- A new COI upload doesn't change policies on its own. The user still taps Suggest and confirms, the same as today.

## 4. Packets and broker sends pull from the vault

- **Send to broker** draft: under *Attachments*, the filled packet plus each current vault doc, each one a checkbox that's pre-ticked when on file. Missing docs show greyed out with a link to add them.
- The server loads the files from Storage and adds them as extra Postmark attachments. Images are converted to PDF, and the total is capped at Postmark's 10 MB, shown as a running total.
- `packet_sends` should record which document ids went out, either in the existing row's metadata or in a small column. That's pick 5, and it's the only part that might want SQL.
- Coverage problems from `coiGaps` (with the packet's load date, as the COI request already does) show as an amber **warning, not a block**.
- Packet fill: fields like "W-9 attached" or "COI attached" can tick themselves when the vault has a current doc. That's a follow-up and not required for v1.
- **Access:** members can't read the owner's `documents` rows under own-row RLS. So the vault and send routes read with the service client, filtered `user_id = ownerId`, the same pattern as the Truck tab (`truckServer.js`). Uploads by management go through the same route and are saved under the **owner's** `user_id` and `{owner}/company/…` path. **No RLS change.**

## 5. Documents tab = load paperwork only

- The list, the Upload "Document type" picker, the Scanner type picker and "Change type" all drop the company types (`isCompanyDocType()`, now including `noa`). What's left: rate con, BOL, POD, lumper receipt, scale ticket and Other. Receipts stay on Expenses, as today.
- A one-line note links to Company → Company documents.
- When a rate con upload turns out to be a COI, it's filed into the vault, and the message links there.
- Load delete never deletes company-type docs. It unlinks them instead.

## 6. Migration: how existing "No load" company docs move over

**No data moves and no SQL is required for v1.**

1. Existing `w9`, `coi` and `mc_authority` rows already have the right `doc_type`. The vault reads them by type, and the Documents tab stops showing them. Their files stay where they are in Storage.
2. "Current" means the newest `created_at` per type, so the newest existing file of each type becomes current and older ones show under Earlier versions. This needs no new column.
3. Company docs that were linked to a load (rare) still show in the vault, because it reads by type regardless of `load_id`. They also stay on that load's page. Nothing is unlinked.
4. **NOA** is the new key `noa`. It needs no SQL, because `doc_type` has no check constraint (the same as `scale_ticket` in #69). It's added to `SCAN_DOC_TYPES` with `company: true`.
5. Files typed as `other:<name>` (e.g. "other:W9") aren't auto-detected. The user can move one with **Change type** (owner and management) before company types leave that picker. Alternatively, the vault offers "Use an existing file".
6. Before the build, Dakota can run these **read-only** checks to see the numbers. They're SELECT only and change nothing:

```sql
select doc_type, (load_id is null) as no_load, count(*) from public.documents
where doc_type in ('w9','coi','mc_authority') group by 1, 2 order by 1, 2;

select id, doc_type, original_filename, created_at from public.documents
where doc_type ilike 'other:%' and doc_type ~* '(w-?9|coi|insur|authority|noa|assignment|factor)';
```

**SQL only if Marc picks it:**
- Pick 1B: a pinned "current" version needs `documents.is_current boolean` or `superseded_at timestamptz`, plus a client update grant.
- Pick 3B: a typed expiry for authority or W-9 needs `documents.expires_on date`.
- Pick 5B: send history per document needs `packet_sends.attached_document_ids uuid[]`.

Each of these would be additive and nullable, written up in plain words for Marc's OK before Dakota runs anything.

## 7. Open design choices (for Marc)

1. **Which version is "current"?** **A:** the newest upload always wins (no SQL). **B:** you can mark an older version as current (one new column). *Recommend A.*
2. **Who can change vault docs?** **A:** owner and management upload and replace, everyone views (same as Insurance). **B:** owner only. *Recommend A.*
3. **Expiry dates beyond the COI.** **A:** only the COI gets an expiry, pulled from Insurance; W-9, MC Authority and NOA show "No expiry". **B:** add a typed expiry or reminder date to every doc (one new column). *Recommend A.* Add a soft "W-9 is over a year old" grey hint, since some brokers want a current-year W-9.
4. **Expired or flagged COI on a broker send.** **A:** warn and untick the COI by default, but still let you send. **B:** block the send until the COI is fixed. *Recommend A.*
5. **Send history.** **A:** list the attached files only in the email (no SQL). **B:** also record which document versions went to each broker in send history (one new column). *Recommend B.* It answers "which COI did that broker get?", but it can come in a follow-up PR.
6. **Attachments format.** **A:** separate PDFs (packet + W-9 + COI + MC + NOA). **B:** one merged PDF. *Recommend A.* Brokers' onboarding tools usually want each document separately.

## 8. Build outline (after approval, not in this PR)

1. Add `noa` to `docTypes.js`. Add a vault helper (`app/lib/companyDocs.js`: group by type, newest = current, status from `coiGaps`) with unit tests.
2. Add `/api/company/documents` (GET, upload, delete; service client scoped to owner; role checks) and the `CompanyDocuments.js` card. Update the Insurance links.
3. Filter company types out of `/documents`, the Scanner, Change type and load delete.
4. Add vault attachments to Send to broker, with a size guard and tests (mocked Postmark).
5. Taylor QA at 390 and 1280, then Marc's merge OK.
