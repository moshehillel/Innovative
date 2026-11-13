# Innovative support tickets vs. live code (Nov 12, 2026)

All 47 Innovative tickets were read in full, resolved ones included: 20 resolved, 27 open or waiting.
Each request was checked against the code live since today's deploy (`main` @ 4033c99) and the live dashboard (`dashboard` @ 77d348e).
The other branch's 67 commits were also re-checked one by one against the live code. That check found the Sarah CC bug below, which last night's merge had missed.

**Legend:**
- **OK:** in the live code.
- **FIXED:** fixed today on branch `fix/innovative-tickets-2026-11-12`, not deployed yet.
- **GAP:** still missing.
- **NEW:** a new feature request.
- **N/A:** nothing to code.

## Fixed today (not live until deployed)
| Ticket | What they asked | What was wrong in live code |
|---|---|---|
| Task - notify customer… (resolved, Oct 15) | Sarah must not be CC'd on the Option B dispatcher email | Still CC'd Sarah. The fix only ever existed on the other branch. |
| Option B (resolved) / 267289 | Dispatcher's ready-to-send customer email must be the same template as Option A, with the right amount | Different template ("Updated rate on shipment…") showing the carrier's charge, not what the customer is billed |
| Option A- Update | For a reweigh or re-dim charge, the email must show the original and updated dims/weight | Not in the Option A email at all |
| Jerry (resolved, Oct 22) | If an email is not an invoice and Jerry is unsure, disregard it when Lisa is copied | Still forwarded to Lisa. It still appears on the daily ignored-emails report. |
| DJ Direct LTL (Nov 12) | The CSV must have only what is on the customer invoice | Had carrier name, carrier invoice # and date, carrier cost, profit and internal IDs. Now: invoice date and #, load, customer, PO, reference, PRO, pieces, weight, class, freight charge, each accessorial, total. |
| Unfinished Notifications email (Nov 12) | Send each person only their own items | One email with every item went to Lisa, Sarah and all 9 dispatchers |
| Drayage (load 270520) | Don't use the routing number as the Primus Bill# | Promised Nov 4, never coded. Now a number labeled Routing/ABA/RTN/Transit is rejected; Jerry uses the "Invoice" number or asks Lisa. |

## Still open
| Ticket | Status |
|---|---|
| Inspection Certificates / Pull inspection certificates (Nov 12) | **GAP.** A price-free reweigh certificate is uploaded to Primus (and so sent with the customer invoice) only when the load goes through the additional-charge approval email. When the reweigh amount already matches Primus, the certificate is never uploaded. Not fixed tonight: it changes the main billing path, and live data is needed to see how often this happens. A certificate that shows prices (e.g. Daylight) is correctly never sent. |
| Pull inspection certificates from the carrier's website (Nov 12) | **NEW.** Only XPO is fetched online today (Imaging API). Other carriers need one integration each. |
| Option A- Invoices not sent | Waiting on Lisa: should Jerry alert on low margin after A–F? (270194 went out at about a $189 loss.) |
| Dashboard (Nov 4) | "Review" rows without a load number are unknown emails kept for a person to look at (by design). The Lisa-copied rule above removes some of them. |
| Additional Charges email to Sarah and Lisa only (Nov 12) | **OK** for the approval email (To Sarah, CC Lisa, live since today). Two other emails are about a charge: the customer notice, which goes to the customer, and the Option B dispatcher task, which goes to the dispatcher because their job in B is to tell the customer. If Rose means the dispatcher should not get that one either, Option B has to change. Confirm with Rose. |

## Checked OK in live code
- **Option A** (268358, 266267, 265087/269728, Option A and E): each accessorial on its own invoice line; customer emailed in Lisa's wording; BOL attached; customer email from the Primus bill-to contacts; the task closes; no amount re-check or margin stop after A–F; Primus accessorial dropdown with a filter.
- **Options B/E:** 30% default markup (a real value, not a grey placeholder) on the dashboard and the email page, percent or flat, Add accessorial on every option.
- **Option D:** dispute tab on the dashboard; notes saved and put in the carrier dispute draft.
- **Option F:** flat or percent of the carrier invoice, billed as accessorial "Freight".
- **Approval emails:** To Sarah, CC Lisa; no dispatcher. Every charge gets both an email and a dashboard row.
- **COI:** attached to the customer invoice email for insured loads.
- **Charge reading:**
  - The difference is always the invoice total minus the Primus amount; line haul is never the extra charge.
  - A named accessorial wins over "reweigh".
  - Credit lines don't hold a load (269295).
  - A POD marked delivered short is still invoiced.
- **Central Transport:** every PDF is read one at a time, including PDFs inside ZIP files.
- **No resends:** already-sent or already-issued invoices, statement replays (257316) and QuickBooks re-pushes are all blocked (268803).
- **Missing POD:** its own tab with a finish button; Damaged POD is kept off that list; Jerry checks Primus every morning (Lisa asked for twice a week).
- **Missing carrier rate:** goes to the dispatcher.
- **Dashboard:**
  - Lists and searches: filters by issue and by dispatcher name (Leo, Jak, Tina, Jason, Alex, Jay, Karen, Barry, Leah); auto-assign from the email's To/Cc; Assign emails the new owner; Done stays done; search covers all open work; sort Newest.
  - Opening emails: A–F links open on left-click, re-checked after last night's dashboard security fix.
- **Drayage:** a GTG reply with a container number invoices the load; unbilled actual-cost lines are removed.
- **Alerts:** emails still go out (the portal-only switch is off).

## Not checkable from code
- **Speed** ("taking a long time", "60 seconds"): needs timing on the live system.
- **Statement Check:** a one-off spreadsheet, already emailed.
- **Live data:** a read-only query of recent invoices (certificate outcomes) was blocked by this session's permissions.
