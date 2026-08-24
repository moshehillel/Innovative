# Jerry AI history learner

Practical first version: export classification/outcome history and mine
feedback for Jerry — **not** Claude fine-tuning.

## What it learns from

1. **BigQuery** `tai-invoice-automation.invoice_automation.logs`
   - AI / mail / intake rows with classification, POD heuristic skips,
     payment-notification ignores, requeues, intents in `details`
2. **Firestore** `emailIntake` (optional)
   - `finalStatus`, `classification.intent`, subject/from

It builds examples shaped like:

`(subject, from, body snippet, AI intent, actual outcome / correction signal)`

and **correlates by `messageId`** across BigQuery + Firestore so intent and
finalStatus land on the same row when possible.

Feedback buckets include:

- `false_pod_heuristic_blocked_by_ai`
- `false_payment_ignore` / `payment_notification_ignored`
- `misrouted_carrier_invoice` / `possible_noa_vs_invoice_conflict`
- `correct_carrier_invoice`
- `requeue_or_correction`

Then suggests:

- subject-token heuristics for mistake clusters
- few-shot JSON examples (positive + negative) for prompts / regression tests

## Auth

```bash
gcloud auth application-default login
# or
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json
```

Project default: `tai-invoice-automation`.

## Run

```bash
cd tools/ai-history-learner
pip install -r requirements.txt
python learn_from_history.py --days 14
python learn_from_history.py --days 30 --out-dir ./out/run1 --skip-firestore
python learn_from_history.py --dry-run-schema
```

Outputs under `out/<timestamp>/`:

- `feedback_examples.json`
- `suggested_updates.json` (rules + few-shots)
- `report.md`
