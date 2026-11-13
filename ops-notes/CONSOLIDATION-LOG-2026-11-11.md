# Night consolidation log (started 2026-11-11 ~23:45)

## 1. Backups (done, verified)
- Full git bundle of all 48 refs (every local + GitHub branch, tags, stashes): `C:\Users\Moshe\Desktop\custom-projects\_git-backup-2026-11-11\innovative-all-refs.bundle` (verified OK).
- List of every branch tip hash: `..\_git-backup-2026-11-11\all-refs.txt`.
- 7 stashes exported as patches: `..\_git-backup-2026-11-11\stashes\`.
- Uncommitted change in this folder (records never expire, for QuickBooks statements, not built yet) saved as `..\_git-backup-2026-11-11\uncommitted-quote-rules-index.js.patch`. NOT put into main.

## 2. What is actually live right now (read-only check, every file compared)
Project `tai-invoice-automation`: 112 live functions in TWO codebases (`default` = functions/, `email-actions` = functions-email-actions/; the handoff missed the second one).
Production is a patchwork of 5 different code versions:
| Deployed | Code version | Functions |
|---|---|---|
| Nov 5 | Line A @ 8b784cd (exact) | ~90 functions: processInvoice, checkMailInbox, all quote-tool functions, reports, dashboard reads, webhooks... |
| Nov 9 | Line A @ 20d5b95 email-actions codebase (exact) | continueWorkflow, finalizeAdditionalChargeInvoice, enterInvoiceLoadNumber, setCustomerRate, executeAdditionalChargeDecision, dashboardAdditionalChargeDecision, getDashboardAccessorials, sendDashboardNotificationDigest |
| Nov 10 | Line A @ f032c82 (exact) | setDashboardCustomerRate |
| Nov 11 23:06 UTC | Line A @ 9d06e71 (exact, speed work) | getDashboardTasks, getDashboardNotifications |
| Nov 12 02:30 UTC | **Line B @ e6b71af (exact)** | **processPrimusWorkflow, processGmailQueue, additionalChargeAction, checkGmailInbox**, reportDjDirectLtlInvoices(+Weekly), reassignDashboardWork, getDashboardEmailAttachment |
=> The core billing pipeline (Gmail queue -> Primus workflow -> additional charges) runs Line B code, which lacks many Line A checks. This is the "fixes reverted" pattern.
Downloaded copies of the live code: `..\_git-backup-2026-11-11\live-src\`, full list `live-functions.csv`.

## 3. Problems found along the way (not merge-related)
- SECURITY (dashboard UI, `dashboard` branch): email bodies are shown in an iframe with `allow-scripts allow-same-origin`, and only `<script>` tags are stripped. An email with e.g. `<img onerror=...>` could run code inside the logged-in dashboard. Exists today. Fix planned in the UI step.
- BUG (Line A, live since Nov 5): late-detected drayage invoices referenced an undefined `emailHtml` variable -> crash instead of forwarding to Leo. Fixed by porting Line B's email HTML capture.
- `executeFinalizeAdditionalChargeInvoice` defined twice in index.js (identical); remove the copy.
- DEPLOY TRAP: in Line A, `additionalChargeAction` (Sarah's A-F link page) belongs to the fast `email-actions` codebase. Today's 02:30 deploy from Line B re-registered it under the `default` codebase with Line B's page. Final deploy must put it back in `email-actions` FIRST, before any `default` deploy, and never use --force on a full default deploy.

## 4. Consolidation branch `consolidate/main` (folder Innovative-consolidate), base = Line A tip 9d06e71
- 433be2d: dashboard rows show the real email; Mark done on invoice-hold rows works (was failing "Task not found"); drayage late-detect crash fixed.
- 8f375f1: Nov 11 live fixes kept (no amount/low-margin re-check after A-F; To Sarah CC Lisa; DJ Direct weekly report; saveOutboundEmail returns result + strips file bytes; visible Primus dropdown on the option A/B/E page).
- Decision: unknown emails stay as "Review" tasks in Work (Line A design, what is live). Line B had removed them on Oct 7.
- LIVE BUG (Line B, live tonight): the exact-duplicate-invoice check fails on every call ("The query requires an index") so it never skipped anything. Rewritten to need no index.
- Line B race fix for "decision arrived during paperwork" would continue with stale approval values (could bill without approved accessorials). Ported as "release lock + queue fresh run" instead.
