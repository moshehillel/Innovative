# Innovative: night consolidation report (Nov 11–12, 2026)

## The short version
- **Why fixes kept "reverting":** two backend branches were deployed into the same live project. Each deploy replaced the other branch's code for the functions it touched. Production was running **5 different code versions at once**. The core billing pipeline (Gmail queue → Primus workflow → additional charges) was on the older "ops console" line, which lacked many checks.
- **What I did:** built one merged branch on top of the more complete line (quote-rules/perf) and hand-ported every needed fix from the other line, one by one, with tests. I found and fixed several real bugs along the way.
- **What is NOT done:** the session's permission settings blocked the **production deploy**, pushes to `main` and `dashboard`, and branch deletion. **Nothing live has changed.** The work is on GitHub in new branches, ready to deploy with the steps below.

## Where everything is
| What | Where |
|---|---|
| Merged backend (the new `main`) | GitHub branch `consolidate/main-2026-11-12`, local folder `Innovative-consolidate` |
| Dashboard security fix | GitHub branch `dashboard-email-safety-2026-11-12` (one commit on top of `dashboard`) |
| Full backup of every branch, tag, stash | `custom-projects\_git-backup-2026-11-11\innovative-all-refs.bundle` (verified) |
| Rollback points (live revision of all 112 functions before any deploy) | `_git-backup-2026-11-11\ROLLBACK-revisions-before-deploy.txt` |
| Downloaded copies of the live code | `_git-backup-2026-11-11\live-src\` |
| Step-by-step log | `Innovative\CONSOLIDATION-LOG-2026-11-11.md` |

## What was live (checked file by file)
| Deployed | Code | Functions |
|---|---|---|
| Nov 5 | quote-rules line @ 8b784cd | ~90 (intake, reports, quote tool, dashboard reads) |
| Nov 9 | quote-rules line @ 20d5b95, email-actions codebase | the A–F email-link pages and their workers |
| Nov 10 | quote-rules line @ f032c82 | setDashboardCustomerRate |
| Nov 11 23:06 UTC | quote-rules line @ 9d06e71 (speed work) | getDashboardTasks, getDashboardNotifications |
| **Nov 12 02:30 UTC** | **ops-console line @ e6b71af** | **processPrimusWorkflow, processGmailQueue, checkGmailInbox, additionalChargeAction**, DJ report ×2, reassignDashboardWork, getDashboardEmailAttachment |

## Ported from the ops-console line (all kept, tested)
1. **Today's live fixes:** no amount re-check and no low-margin pause after an A–F decision (a missing customer rate still pauses). Approval email goes **To Sarah, CC Lisa**, never dispatchers. DJ Direct LTL Monday CSV report, which now fails loudly if the email doesn't send.
2. **"Mark done" on Missing POD / missing customer rate rows** used to fail with "Task not found" and the row came back. It works now.
3. **Dispute notes (option D):** the dashboard sent them, but the backend dropped them. They're now saved and included in the carrier dispute draft. The email-link page has a notes box too.
4. **Accessorial codes** picked on the page or dashboard now reach the Primus invoice line (they were dropped).
5. **Credit lines no longer hold a load** (load 269295: -$40 per diem), and named detention opens the A–F options email.
6. **"Already invoiced by another user"** in ShipPrimus now finishes billing as done instead of failing. The booking is checked again just before saving.
7. **Two or more invoice PDFs are read one at a time**, and a failed combined read falls back to reading each one (Central Transport batches lost the second invoice).
8. **Carrier PDFs inside forwarded Outlook mail** are read even when only `name=` is given.
9. **A named accessorial (redelivery, liftgate…) is the charge reason** even when weight also differs.
10. **Dashboard rows show the real email** (full HTML) instead of a 4,000-character text dump. Approval emails show their A–F buttons.
11. **Tenant isolation:** rows with no tenant were visible to, and changeable by, every tenant's dashboard.
12. **Assign (reassignDashboardWork)** and the attachment endpoint, both called by the dashboard.
13. **Finished work clears its matching notification.**
14. **Exact duplicate invoice resent in a new email** is skipped.
15. **Outgoing-email records store file names, not PDF bytes** (Firestore 1 MB limit), and customer charge notices always send.

## Bugs found and fixed (in neither line, or in both)
- **Live tonight:** the ops line's duplicate-invoice check failed on **every** call ("query requires an index", 261 times in 7 days), so it never caught a duplicate. I rewrote it to need no index. A copy whose first run failed is processed again.
- The ops line's "decision arrived during paperwork" fix kept billing with stale approval values, which could drop the approved accessorials. Ported safely instead: release the lock and queue a fresh run (within 5 minutes).
- Quote-rules line: late-detected drayage invoices crashed (`emailHtml` was undefined) instead of forwarding to Leo.
- **Notifications "Load more" repeated the same rows**, and the badge showed 50 instead of the real count. Fixed: real paging and counts. Search now covers every open notification without loading email HTML.
- **Security (dashboard UI):** email HTML was shown in a frame with scripts allowed, and only `<script>` tags were removed. An email with `<img onerror=…>` could run code in the logged-in dashboard. Email HTML is now cleaned in an inert document (tested against 16 attack samples). Normal emails, images and A–F links are kept.
- `executeFinalizeAdditionalChargeInvoice` was defined twice. Removed the copy.

## Kept as the quote-rules line has it (product choices you can reverse)
- Unknown emails stay as "Review" items in Work (ops line had removed them Oct 7; the newer Nov 3 design routes them to dispatchers).
- Option B: the dispatcher gets instructions plus a "Customer notified — complete invoice" button, and billing waits until it's clicked. The ops line sent only the customer notice text, with no wait.
- Chase Zelle/ACH alerts are quietly ignored (Sept 3 decision). **Since this morning's deploy, live forwards them**; the new code ignores them again.
- Simple "invoice paid" replies on Invoice/BOL threads are quietly ignored, not forwarded to Abe (Sept 14 decision).
- Non-invoice emails where Lisa is already copied are still forwarded and kept as a Review row (the ops line dropped them silently).
- Drayage is decided by the carrier's Primus vendor type, and container numbers must be real ISO IDs.
- Load lookup tries the PRO only when the invoice has no BOL at all.

## Quoting vs accounting
- Accounting dashboard has no quote code, and the quote dashboard has no accounting code (both checked).
- Removed three dead quote branches from the accounting mail intake (hard-switched off already).
- Shared code that stays: Primus customer search, the Primus accessorial list and the Primus login session (both products need Primus).
- **The 37 quote functions are deliberately left out of the deploy below**, so quoting is untouched.

## Tests
- Quote-rules line's own tests: **75 pass**. Of the 2 failures, one needs the network (blocked on purpose in tests), and `quote-rate-normalize` was already failing before tonight (see question 1).
- Ops line's tests on the merged code: 27 pass. The rest check its own function names, or behaviors where the newer design was kept (listed above).
- Lint: no new errors (the line already had 265; deploys skip lint).

## Deploy steps (run in `Innovative-consolidate`, in this order, ~15 min total)
The env file is already in place (`functions/.env.tai-invoice-automation`, ignored by git). Settings were checked against all 75 live accounting functions and match exactly, including `DASHBOARD_OPS_PRIMARY=false`.

**Stage 1. Core billing (10 functions):**
```
node _submit-cloudbuild-temp.js _cloudbuild-consolidate-stage1.yaml
```
Then watch the logs for 10 minutes. If anything is wrong, roll back from `ROLLBACK-revisions-before-deploy.txt`, e.g.
`gcloud run services update-traffic processgmailqueue --region=us-central1 --to-revisions=processgmailqueue-00306-hol=100`

**Stage 2. Give `additionalChargeAction` back to the fast email-actions codebase.** The A–F links are down for about a minute. I was not allowed to write this file; make `_cloudbuild-consolidate-stage2.yaml` as a copy of stage 1, with the deploy line replaced by:
```
firebase functions:delete additionalChargeAction --region=us-central1 --project=tai-invoice-automation --force --non-interactive
firebase deploy --config=_firebase-deploy-nolint.json --only=functions:email-actions --project=tai-invoice-automation --non-interactive
```
(Keep the `cp functions/.env… functions-email-actions/` line: the email-actions env file from Sept 2 is out of date.)

**Stage 3. The other 60 accounting functions:**
```
node _submit-cloudbuild-temp.js _cloudbuild-consolidate-stage3.yaml
```
Never run a full `--only=functions` deploy with `--force`: it deletes live functions missing from the source.

**After deploy:**
1. Make `main` the merged branch: `git push origin origin/consolidate/main-2026-11-12:refs/heads/main` (a plain fast-forward; the merge already contains today's `main`).
2. Push the dashboard fix live: `git push origin dashboard-email-safety-2026-11-12:dashboard` (Netlify auto-deploys).

## Branch cleanup (after main is updated)
- **Safe to delete (fully inside the merge):** `feat/quote-rules-chat-agent`, `perf/dashboard-list-speed`, `chore/intake-ttl-60`, `fix/quote-queue-drain`, `fix/send-already-billed-customer-emails`, plus the scratch `integration/*` branches.
- **`feat/dashboard-ops-console`:** everything needed is ported. Delete once the deploy is verified (it's in the backup bundle either way).
- **Review before deleting (August work never merged in either line):** `fix/accessorial-inquiry-not-request` (don't treat a question about an accessorial as a request; not present anywhere), `fix/quote-dim-order-lwh` (Children's Apparel rate alerts to Sarah and others, partly present), `fix/skip-paid-resent-invoices`, `fix/skip-qb-repush-already-issued`, `cursor/carrier-bill-issued-fdbc` (mostly covered differently), `fix/comfortel-dim-order-legend` (fully present), `fix/dedupe-cannot-email-alerts` (covered), `cursor/setup-cloud-agent-env-d810` (dev tooling only).
- **Keep:** `main`, `dashboard`, `quote-dashboard`.

## Open questions for you
1. **Quote matching:** "Acme Warehouse" matches the Primus customer "Acme Industries" because a Sept 15 change accepts a shared 4-letter word. A new shipper could be quoted with another customer's rates. Billing is not affected (it requires an exact name). Keep it, or go back to 5 letters?
2. The six product choices above: confirm or reverse any of them.
3. The quote tool's inbox sync (`syncQuoteOutlookInboxes`) ran out of memory (1 GB) twice and timed out once in the last 2 days. I left it alone.
