"""
Jerry AI history learner — mines past classifications vs outcomes.

This does NOT fine-tune Claude. It exports feedback examples from history
and suggests heuristics / few-shot snippets Jerry can use later.

Auth (pick one):
  gcloud auth application-default login
  # or set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON

Examples:
  python learn_from_history.py --days 14
  python learn_from_history.py --days 30 --out-dir ./out
  python learn_from_history.py --project tai-invoice-automation --dataset invoice_automation
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

DEFAULT_PROJECT = os.environ.get("GCP_PROJECT") or os.environ.get(
    "GOOGLE_CLOUD_PROJECT") or "tai-invoice-automation"
DEFAULT_DATASET = os.environ.get("BQ_DATASET") or "invoice_automation"
DEFAULT_LOGS_TABLE = "logs"

# Signals we care about for Jerry email-intent quality.
FALSE_POD_MARKERS = (
    "POD heuristic skipped — AI says not POD request",
    "false POD",
    "not a POD request",
)
PAYMENT_IGNORE_STATUSES = ("payment_notification_ignored",)
REQUEUE_MARKERS = ("requeue", "reprocess", "misrouted")
CLASSIFICATION_MESSAGES = (
    "Email classification",
    "AI classification",
    "classifyIncomingEmail",
)


def _parse_details(raw: Any) -> Dict[str, Any]:
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return raw
    text = str(raw)
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _detail(d: Dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if d.get(key) not in (None, ""):
            return d[key]
        nested = d.get("details")
        if isinstance(nested, dict) and nested.get(key) not in (None, ""):
            return nested[key]
        cls = d.get("classification") or d.get("emailClassification")
        if isinstance(cls, dict) and cls.get(key) not in (None, ""):
            return cls[key]
    return None


def fetch_bigquery_logs(
    project: str,
    dataset: str,
    days: int,
    limit: int,
) -> List[Dict[str, Any]]:
    try:
        from google.cloud import bigquery
    except ImportError as exc:
        raise SystemExit(
            "Missing dependency: google-cloud-bigquery\n"
            "  pip install -r requirements.txt\n"
            f"Original error: {exc}"
        ) from exc

    client = bigquery.Client(project=project)
    table = f"`{project}.{dataset}.{DEFAULT_LOGS_TABLE}`"
    # Pull AI/mail/intake rows that mention classification or known outcomes.
    query = f"""
    SELECT
      timestamp,
      level,
      category,
      message,
      TO_JSON_STRING(details) AS details_json
    FROM {table}
    WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
      AND (
        LOWER(category) IN ('ai', 'mail', 'intake', 'pod')
        OR LOWER(message) LIKE '%classification%'
        OR LOWER(message) LIKE '%pod heuristic%'
        OR LOWER(message) LIKE '%payment_notification%'
        OR LOWER(message) LIKE '%requeue%'
        OR LOWER(message) LIKE '%intent%'
      )
    ORDER BY timestamp DESC
    LIMIT @limit
    """
    job = client.query(
        query,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("days", "INT64", days),
                bigquery.ScalarQueryParameter("limit", "INT64", limit),
            ]
        ),
    )
    rows: List[Dict[str, Any]] = []
    for row in job:
        details = _parse_details(row["details_json"])
        rows.append(
            {
                "timestamp": row["timestamp"].isoformat()
                if hasattr(row["timestamp"], "isoformat")
                else str(row["timestamp"]),
                "level": row["level"],
                "category": row["category"],
                "message": row["message"],
                "details": details,
            }
        )
    return rows


def fetch_firestore_email_intake(days: int, limit: int) -> List[Dict[str, Any]]:
    """Optional secondary source: recent emailIntake outcomes."""
    try:
        import firebase_admin
        from firebase_admin import firestore
    except ImportError:
        return []

    if not firebase_admin._apps:
        firebase_admin.initialize_app(options={"projectId": DEFAULT_PROJECT})
    db = firestore.client()
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    # discoveredAt may be missing on older docs; still try.
    try:
        snap = (
            db.collection("emailIntake")
            .order_by("discoveredAt", direction=firestore.Query.DESCENDING)
            .limit(limit)
            .stream()
        )
    except Exception:
        snap = db.collection("emailIntake").limit(limit).stream()

    out: List[Dict[str, Any]] = []
    for doc in snap:
        data = doc.to_dict() or {}
        data["id"] = doc.id
        discovered = data.get("discoveredAt") or data.get("finishedAt")
        if hasattr(discovered, "timestamp"):
            try:
                if datetime.fromtimestamp(
                    discovered.timestamp(), tz=timezone.utc
                ) < cutoff:
                    continue
            except Exception:
                pass
        out.append(data)
    return out


def row_to_example(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    details = row.get("details") or {}
    message = str(row.get("message") or "")
    intent = _detail(details, "intent")
    subject = _detail(details, "subject")
    from_addr = _detail(details, "from", "fromAddress", "sender")
    body_snip = _detail(details, "bodySnippet", "bodyPreview", "emailBody")
    if isinstance(body_snip, str) and len(body_snip) > 400:
        body_snip = body_snip[:400]
    final_status = _detail(details, "finalStatus", "outcomeReason", "status")
    message_id = _detail(details, "messageId", "gmailMessageId")

    label = None
    msg_l = message.lower()
    if "pod heuristic skipped" in msg_l:
        label = "false_pod_heuristic_blocked_by_ai"
    elif final_status in PAYMENT_IGNORE_STATUSES:
        label = "payment_notification_ignored"
    elif any(m in msg_l for m in ("requeue", "reprocess")):
        label = "requeue_or_correction"
    elif intent:
        label = f"intent:{intent}"
    elif "classification" in msg_l:
        label = "classification_event"
    else:
        return None

    return {
        "timestamp": row.get("timestamp"),
        "message": message,
        "category": row.get("category"),
        "messageId": message_id,
        "subject": subject,
        "from": from_addr,
        "bodySnippet": body_snip,
        "aiIntent": intent,
        "finalStatus": final_status,
        "feedbackLabel": label,
        "detailsKeys": sorted(list(details.keys()))[:30],
    }


def intake_to_example(row: Dict[str, Any]) -> Dict[str, Any]:
    cls = row.get("classification") or row.get("emailClassification") or {}
    if not isinstance(cls, dict):
        cls = {}
    subject = row.get("subject")
    body = row.get("bodySnippet") or row.get("bodyPreview") or ""
    if isinstance(body, str) and len(body) > 400:
        body = body[:400]
    return {
        "timestamp": str(row.get("discoveredAt") or row.get("finishedAt") or ""),
        "message": "emailIntake",
        "category": "intake",
        "messageId": row.get("id") or row.get("gmailMessageId"),
        "subject": subject,
        "from": row.get("from") or row.get("fromAddress"),
        "bodySnippet": body,
        "aiIntent": cls.get("intent") or row.get("intent"),
        "finalStatus": row.get("finalStatus") or row.get("outcomeReason"),
        "feedbackLabel": f"intake:{(row.get('finalStatus') or 'unknown')}",
        "source": "firestore_emailIntake",
    }


def tokenize_subject(subject: Optional[str]) -> List[str]:
    if not subject:
        return []
    tokens = re.findall(r"[a-z0-9]{3,}", str(subject).lower())
    stop = {
        "the", "and", "for", "from", "with", "your", "this", "that", "load",
        "invoice", "fwd", "fw", "re",
    }
    return [t for t in tokens if t not in stop]


def mine_patterns(examples: List[Dict[str, Any]]) -> Dict[str, Any]:
    by_label: Dict[str, List[Dict[str, Any]]] = collections.defaultdict(list)
    for ex in examples:
        by_label[ex["feedbackLabel"]].append(ex)

    subject_tokens_by_label: Dict[str, collections.Counter] = {
        label: collections.Counter() for label in by_label
    }
    intent_vs_status: collections.Counter = collections.Counter()
    for label, items in by_label.items():
        for ex in items:
            for tok in tokenize_subject(ex.get("subject")):
                subject_tokens_by_label[label][tok] += 1
            intent = ex.get("aiIntent") or "?"
            status = ex.get("finalStatus") or "?"
            intent_vs_status[f"{intent} -> {status}"] += 1

    # Suggested few-shot / heuristic candidates from mistake-like labels.
    mistake_labels = {
        "false_pod_heuristic_blocked_by_ai",
        "payment_notification_ignored",
        "requeue_or_correction",
    }
    few_shot: List[Dict[str, Any]] = []
    suggested_rules: List[Dict[str, Any]] = []

    for label in sorted(mistake_labels):
        items = by_label.get(label) or []
        for ex in items[:25]:
            few_shot.append(
                {
                    "why": label,
                    "subject": ex.get("subject"),
                    "from": ex.get("from"),
                    "aiIntent": ex.get("aiIntent"),
                    "finalStatus": ex.get("finalStatus"),
                    "bodySnippet": ex.get("bodySnippet"),
                    "note": (
                        "Use as a negative/positive few-shot when prompting "
                        "classifyIncomingEmail, or as a regression fixture."
                    ),
                }
            )
        top_tokens = subject_tokens_by_label[label].most_common(12)
        if top_tokens:
            suggested_rules.append(
                {
                    "label": label,
                    "type": "subject_token_frequency",
                    "topSubjectTokens": [
                        {"token": t, "count": c} for t, c in top_tokens
                    ],
                    "suggestion": (
                        f"Review subjects containing these tokens for {label}; "
                        "consider hardening heuristics or adding few-shot "
                        "examples rather than fine-tuning."
                    ),
                }
            )

    # payment ignore false-positive hint: invoice-like subjects with that status
    payment_items = by_label.get("payment_notification_ignored") or []
    invoice_like = []
    for ex in payment_items:
        sub = str(ex.get("subject") or "")
        if re.search(r"invoice|e-?invoice|payment request", sub, re.I):
            invoice_like.append(ex)
    if invoice_like:
        suggested_rules.append(
            {
                "label": "payment_notification_ignored",
                "type": "possible_false_positive",
                "count": len(invoice_like),
                "examples": [
                    {
                        "subject": e.get("subject"),
                        "from": e.get("from"),
                        "aiIntent": e.get("aiIntent"),
                    }
                    for e in invoice_like[:15]
                ],
                "suggestion": (
                    "Subjects that look like carrier invoices but ended as "
                    "payment_notification_ignored — tighten "
                    "isPaymentNotificationEmail / looksLikeInvoiceEmailContent."
                ),
            }
        )

    return {
        "countsByLabel": {k: len(v) for k, v in sorted(by_label.items())},
        "intentVsFinalStatusTop": intent_vs_status.most_common(40),
        "suggestedRules": suggested_rules,
        "fewShotExamples": few_shot,
    }


def write_report(
    out_dir: Path,
    examples: List[Dict[str, Any]],
    mined: Dict[str, Any],
    meta: Dict[str, Any],
) -> Tuple[Path, Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    examples_path = out_dir / "feedback_examples.json"
    suggestions_path = out_dir / "suggested_updates.json"
    report_path = out_dir / "report.md"

    examples_path.write_text(
        json.dumps(examples, indent=2, default=str), encoding="utf-8"
    )
    suggestions_path.write_text(
        json.dumps(
            {
                "meta": meta,
                "countsByLabel": mined["countsByLabel"],
                "suggestedRules": mined["suggestedRules"],
                "fewShotExamples": mined["fewShotExamples"],
                "intentVsFinalStatusTop": mined["intentVsFinalStatusTop"],
            },
            indent=2,
            default=str,
        ),
        encoding="utf-8",
    )

    lines = [
        "# Jerry AI history learner report",
        "",
        f"- Generated: {meta.get('generatedAt')}",
        f"- Project: `{meta.get('project')}` dataset `{meta.get('dataset')}`",
        f"- Window: last {meta.get('days')} day(s)",
        f"- BigQuery rows scanned: {meta.get('bqRows')}",
        f"- Firestore emailIntake rows: {meta.get('intakeRows')}",
        f"- Feedback examples built: {len(examples)}",
        "",
        "## What this learns",
        "",
        "Pulls recent BigQuery `logs` (and optional Firestore `emailIntake`)",
        "to pair subject/from/body snippets with AI intent and final outcomes.",
        "It mines false-POD heuristic blocks, payment-ignore outcomes,",
        "requeues/corrections, and intent→status distributions — then exports",
        "few-shot examples and heuristic suggestions. It does **not** fine-tune",
        "Claude.",
        "",
        "## Counts by feedback label",
        "",
    ]
    for label, count in mined["countsByLabel"].items():
        lines.append(f"- `{label}`: {count}")
    lines.extend(["", "## Suggested rule updates", ""])
    if not mined["suggestedRules"]:
        lines.append("_No strong rule suggestions in this window._")
    for rule in mined["suggestedRules"]:
        lines.append(f"### {rule.get('label')} ({rule.get('type')})")
        lines.append("")
        lines.append(rule.get("suggestion") or "")
        lines.append("")
        if rule.get("topSubjectTokens"):
            toks = ", ".join(
                f"{t['token']}({t['count']})" for t in rule["topSubjectTokens"][:8]
            )
            lines.append(f"Top subject tokens: {toks}")
            lines.append("")
    lines.extend(
        [
            "## Outputs",
            "",
            f"- `{examples_path.name}` — training/feedback examples",
            f"- `{suggestions_path.name}` — rules + few-shot JSON for Jerry",
            "",
        ]
    )
    report_path.write_text("\n".join(lines), encoding="utf-8")
    return examples_path, suggestions_path, report_path


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Mine Jerry AI classification history for feedback."
    )
    parser.add_argument("--project", default=DEFAULT_PROJECT)
    parser.add_argument("--dataset", default=DEFAULT_DATASET)
    parser.add_argument("--days", type=int, default=14)
    parser.add_argument("--limit", type=int, default=5000)
    parser.add_argument(
        "--out-dir",
        default=str(
            Path(__file__).resolve().parent
            / "out"
            / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        ),
    )
    parser.add_argument(
        "--skip-firestore",
        action="store_true",
        help="Only query BigQuery (default also tries emailIntake).",
    )
    parser.add_argument(
        "--dry-run-schema",
        action="store_true",
        help="Print expected fields and exit without querying.",
    )
    args = parser.parse_args(argv)

    if args.dry_run_schema:
        print(
            json.dumps(
                {
                    "bigquery": f"{args.project}.{args.dataset}.logs",
                    "fields": [
                        "timestamp",
                        "level",
                        "category",
                        "message",
                        "details (JSON: subject, from, intent, finalStatus, ...)",
                    ],
                    "firestore": "emailIntake (finalStatus, classification.intent)",
                },
                indent=2,
            )
        )
        return 0

    print(f"Querying BigQuery {args.project}.{args.dataset}.logs (last {args.days}d)...")
    bq_rows = fetch_bigquery_logs(
        args.project, args.dataset, args.days, args.limit
    )
    print(f"  got {len(bq_rows)} log rows")

    intake_rows: List[Dict[str, Any]] = []
    if not args.skip_firestore:
        print("Trying Firestore emailIntake...")
        try:
            intake_rows = fetch_firestore_email_intake(args.days, min(args.limit, 2000))
            print(f"  got {len(intake_rows)} intake rows")
        except Exception as exc:
            print(f"  skipped Firestore ({exc})")

    examples: List[Dict[str, Any]] = []
    for row in bq_rows:
        ex = row_to_example(row)
        if ex:
            examples.append(ex)
    for row in intake_rows:
        examples.append(intake_to_example(row))

    mined = mine_patterns(examples)
    meta = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "project": args.project,
        "dataset": args.dataset,
        "days": args.days,
        "bqRows": len(bq_rows),
        "intakeRows": len(intake_rows),
        "note": (
            "Feedback mining + suggested heuristics/few-shots; "
            "not Claude fine-tuning."
        ),
    }
    out_dir = Path(args.out_dir)
    examples_path, suggestions_path, report_path = write_report(
        out_dir, examples, mined, meta
    )
    print(f"Wrote {examples_path}")
    print(f"Wrote {suggestions_path}")
    print(f"Wrote {report_path}")
    print("Label counts:", json.dumps(mined["countsByLabel"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
