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
PAYMENT_IGNORE_STATUSES = frozenset({
    "payment_notification_ignored",
})
NOA_IGNORE_STATUSES = frozenset({
    "noa_ignored",
})
SUCCESS_INVOICE_STATUSES = frozenset({
    "processing",
    "already_billed_skipped",
    "additional_charge_pending_approval",
})
MISROUTE_IGNORE_STATUSES = frozenset({
    "payment_notification_ignored",
    "noa_ignored",
    "emodal_broadcast_ignored",
    "past_due_only",
    "statement_ignored_abe_cc",
    "no_attachment",
    "no_invoice_pdf",
})
REQUEUE_MARKERS = ("requeue", "reprocess", "misrouted")
INVOICE_SUBJECT_RE = re.compile(
    r"invoice|e-?invoice|payment\s+request|pro\s*#?\s*\d|bol\s*#?\s*\d",
    re.I,
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


def _clip(text: Any, n: int = 400) -> Optional[str]:
    if text is None:
        return None
    s = str(text)
    return s if len(s) <= n else s[:n]


def label_intent_vs_outcome(
    intent: Optional[str],
    final_status: Optional[str],
    subject: Optional[str] = None,
) -> Optional[str]:
    """Map AI intent + finalStatus into a feedback bucket."""
    intent_s = str(intent or "").strip()
    status = str(final_status or "").strip()
    sub = str(subject or "")

    if status in PAYMENT_IGNORE_STATUSES:
        if intent_s == "carrier_invoice" or INVOICE_SUBJECT_RE.search(sub):
            return "false_payment_ignore"
        return "payment_notification_ignored"

    if status in NOA_IGNORE_STATUSES and intent_s == "carrier_invoice":
        return "possible_noa_vs_invoice_conflict"

    if intent_s == "carrier_invoice" and status in SUCCESS_INVOICE_STATUSES:
        return "correct_carrier_invoice"

    if intent_s == "carrier_invoice" and status in MISROUTE_IGNORE_STATUSES:
        return "misrouted_carrier_invoice"

    if intent_s == "pod_request" and status and "pod" not in status.lower():
        if status in MISROUTE_IGNORE_STATUSES or status in (
            "forwarded",
            "processing",
        ):
            return "possible_pod_misroute"

    if intent_s and status:
        return f"intent:{intent_s}|status:{status}"
    if intent_s:
        return f"intent:{intent_s}"
    if status:
        return f"status:{status}"
    return None


def row_to_example(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    details = row.get("details") or {}
    message = str(row.get("message") or "")
    intent = _detail(details, "intent")
    subject = _detail(details, "subject")
    from_addr = _detail(details, "from", "fromAddress", "sender")
    body_snip = _clip(
        _detail(details, "bodySnippet", "bodyPreview", "emailBody", "reasoning")
    )
    final_status = _detail(details, "finalStatus", "outcomeReason", "status")
    message_id = _detail(details, "messageId", "gmailMessageId")
    reasoning = _detail(details, "reasoning")

    label = None
    msg_l = message.lower()
    if "pod heuristic skipped" in msg_l:
        label = "false_pod_heuristic_blocked_by_ai"
    elif message == "Incoming email classified":
        label = label_intent_vs_outcome(intent, final_status, subject) or (
            f"intent:{intent}" if intent else "incoming_email_classified"
        )
    elif any(m in msg_l for m in REQUEUE_MARKERS):
        label = "requeue_or_correction"
    else:
        label = label_intent_vs_outcome(intent, final_status, subject)
        if not label and "classification" in msg_l:
            label = "classification_event"
        if not label:
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
        "aiReasoning": _clip(reasoning, 240),
        "finalStatus": final_status,
        "feedbackLabel": label,
        "detailsKeys": sorted(list(details.keys()))[:30],
        "source": "bigquery_logs",
    }


def intake_to_example(row: Dict[str, Any]) -> Dict[str, Any]:
    cls = row.get("classification") or row.get("emailClassification") or {}
    if not isinstance(cls, dict):
        cls = {}
    subject = row.get("subject")
    body = _clip(row.get("bodySnippet") or row.get("bodyPreview") or "")
    intent = cls.get("intent") or row.get("intent")
    final_status = row.get("finalStatus") or row.get("outcomeReason")
    label = label_intent_vs_outcome(intent, final_status, subject) or (
        f"intake:{(final_status or 'unknown')}"
    )
    return {
        "timestamp": str(row.get("discoveredAt") or row.get("finishedAt") or ""),
        "message": "emailIntake",
        "category": "intake",
        "messageId": row.get("id") or row.get("gmailMessageId"),
        "subject": subject,
        "from": row.get("from") or row.get("fromAddress"),
        "bodySnippet": body,
        "aiIntent": intent,
        "aiReasoning": _clip(cls.get("reasoning"), 240),
        "finalStatus": final_status,
        "feedbackLabel": label,
        "source": "firestore_emailIntake",
    }


def correlate_by_message_id(
    bq_rows: List[Dict[str, Any]],
    intake_rows: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Join AI classification logs with later outcomes for the same messageId."""
    by_id: Dict[str, Dict[str, Any]] = collections.defaultdict(dict)

    for row in bq_rows:
        details = row.get("details") or {}
        mid = str(_detail(details, "messageId", "gmailMessageId") or "").strip()
        if not mid:
            continue
        slot = by_id[mid]
        msg = str(row.get("message") or "")
        if msg == "Incoming email classified" or (
            "classification" in msg.lower() and _detail(details, "intent")
        ):
            slot["aiIntent"] = _detail(details, "intent") or slot.get("aiIntent")
            slot["aiReasoning"] = _detail(details, "reasoning") or slot.get(
                "aiReasoning"
            )
            slot["subject"] = _detail(details, "subject") or slot.get("subject")
            slot["from"] = (
                _detail(details, "from", "fromAddress", "sender")
                or slot.get("from")
            )
            slot["classifiedAt"] = row.get("timestamp")
        if "pod heuristic skipped" in msg.lower():
            slot["podHeuristicBlocked"] = True
            slot["podBlockReasoning"] = _detail(details, "reasoning")
            slot["subject"] = _detail(details, "subject") or slot.get("subject")
            slot["aiIntent"] = _detail(details, "intent") or slot.get("aiIntent")
        status = _detail(details, "finalStatus", "outcomeReason", "status")
        if status:
            slot["finalStatus"] = status
        if any(m in msg.lower() for m in REQUEUE_MARKERS):
            slot["requeued"] = True

    for row in intake_rows:
        mid = str(row.get("id") or row.get("gmailMessageId") or "").strip()
        if not mid:
            continue
        slot = by_id[mid]
        cls = row.get("classification") or row.get("emailClassification") or {}
        if not isinstance(cls, dict):
            cls = {}
        slot["aiIntent"] = cls.get("intent") or row.get("intent") or slot.get(
            "aiIntent"
        )
        slot["aiReasoning"] = cls.get("reasoning") or slot.get("aiReasoning")
        slot["subject"] = row.get("subject") or slot.get("subject")
        slot["from"] = (
            row.get("from") or row.get("fromAddress") or slot.get("from")
        )
        slot["finalStatus"] = (
            row.get("finalStatus")
            or row.get("outcomeReason")
            or slot.get("finalStatus")
        )
        slot["bodySnippet"] = _clip(
            row.get("bodySnippet") or row.get("bodyPreview") or ""
        )
        slot["intakeSource"] = True

    correlated: List[Dict[str, Any]] = []
    for mid, slot in by_id.items():
        intent = slot.get("aiIntent")
        status = slot.get("finalStatus")
        subject = slot.get("subject")
        if slot.get("podHeuristicBlocked"):
            label = "false_pod_heuristic_blocked_by_ai"
        elif slot.get("requeued"):
            label = "requeue_or_correction"
        else:
            label = label_intent_vs_outcome(intent, status, subject)
        if not label:
            continue
        correlated.append(
            {
                "timestamp": slot.get("classifiedAt") or "",
                "message": "correlated_message_outcome",
                "category": "learned",
                "messageId": mid,
                "subject": subject,
                "from": slot.get("from"),
                "bodySnippet": slot.get("bodySnippet"),
                "aiIntent": intent,
                "aiReasoning": _clip(slot.get("aiReasoning"), 240),
                "finalStatus": status,
                "feedbackLabel": label,
                "source": "correlated",
            }
        )
    return correlated


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

    # Mistake + success buckets for few-shot / heuristic candidates.
    priority_labels = [
        "false_pod_heuristic_blocked_by_ai",
        "false_payment_ignore",
        "misrouted_carrier_invoice",
        "possible_noa_vs_invoice_conflict",
        "possible_pod_misroute",
        "requeue_or_correction",
        "payment_notification_ignored",
        "correct_carrier_invoice",
    ]
    few_shot: List[Dict[str, Any]] = []
    suggested_rules: List[Dict[str, Any]] = []

    for label in priority_labels:
        items = by_label.get(label) or []
        # Prefer successes as positive few-shots; mistakes as negatives.
        cap = 15 if label == "correct_carrier_invoice" else 25
        for ex in items[:cap]:
            few_shot.append(
                {
                    "why": label,
                    "subject": ex.get("subject"),
                    "from": ex.get("from"),
                    "aiIntent": ex.get("aiIntent"),
                    "aiReasoning": ex.get("aiReasoning"),
                    "finalStatus": ex.get("finalStatus"),
                    "bodySnippet": ex.get("bodySnippet"),
                    "messageId": ex.get("messageId"),
                    "note": (
                        "Positive few-shot"
                        if label.startswith("correct_")
                        else "Negative/correction few-shot — use in "
                        "classifyIncomingEmail prompts or regression fixtures."
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

    false_pay = by_label.get("false_payment_ignore") or []
    if false_pay:
        suggested_rules.append(
            {
                "label": "false_payment_ignore",
                "type": "possible_false_positive",
                "count": len(false_pay),
                "examples": [
                    {
                        "subject": e.get("subject"),
                        "from": e.get("from"),
                        "aiIntent": e.get("aiIntent"),
                        "finalStatus": e.get("finalStatus"),
                    }
                    for e in false_pay[:15]
                ],
                "suggestion": (
                    "Invoice-like mail (or AI intent carrier_invoice) ended as "
                    "payment_notification_ignored — tighten "
                    "isPaymentNotificationEmail / looksLikeInvoiceEmailContent "
                    "/ ACH alert verbs."
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

    correlated = correlate_by_message_id(bq_rows, intake_rows)
    print(f"  correlated messageId outcomes: {len(correlated)}")
    # Prefer correlated rows (richer intent+outcome); keep raw as fallback.
    seen_ids = {
        str(ex.get("messageId"))
        for ex in correlated
        if ex.get("messageId")
    }
    merged: List[Dict[str, Any]] = list(correlated)
    for ex in examples:
        mid = str(ex.get("messageId") or "")
        if mid and mid in seen_ids:
            continue
        merged.append(ex)

    mined = mine_patterns(merged)
    meta = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "project": args.project,
        "dataset": args.dataset,
        "days": args.days,
        "bqRows": len(bq_rows),
        "intakeRows": len(intake_rows),
        "correlatedRows": len(correlated),
        "note": (
            "Feedback mining + suggested heuristics/few-shots; "
            "not Claude fine-tuning."
        ),
    }
    examples = merged
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
