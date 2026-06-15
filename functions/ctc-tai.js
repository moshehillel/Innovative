/**
 * Coast to Coast Carriers — dedicated TAI TMS integration.
 *
 * A COMPLETE, self-contained copy of the TAI workflow bound to the
 * `coast_to_coast` tenant. Per the per-company file model, each company owns
 * its own file so its TAI credentials, webhook secret, endpoints, and workflow
 * stay fully isolated from every other client. Shared, company-agnostic
 * helpers (logging, email, PDF, POD, storage) still come from index.js via
 * init().
 *
 * Exports (re-exported from index.js): ctcTaiWebhook, ctcTaiResolveShipment,
 * processCtcTaiWorkflow. Credentials (env, falling back to the shared TAI_*
 * vars): TAI_BASE_URL_COAST_TO_COAST, TAI_API_KEY_COAST_TO_COAST,
 * TAI_WEBHOOK_SECRET_COAST_TO_COAST.
 *
 * ── Original module notes ───────────────────────────────────────────────────
 * TAI TMS integration — webhook receiver and shipment index.
 *
 * Unlike Primus (where we look up a booking by load/BOL number on demand),
 * the TAI REST API is keyed by an integer `shipmentId`. Carrier invoices only
 * give us a load number / PRO (text), so we cannot call the TAI API directly.
 *
 * This module solves that by acting as a WEBHOOK RECEIVER: TAI POSTs full
 * shipment payloads to us on create/update/status events, and we build a
 * Firestore index mapping every reference number (load #, PRO, BOL, custom
 * refs) to its `shipmentId`. The invoice workflow then resolves a carrier
 * invoice to a `shipmentId` through this index before any TAI API call.
 *
 * Collections written:
 *   taiShipments/{shipmentId}        - cached ShipmentDetails snapshot
 *   taiShipmentLookups/{refKey}      - refKey -> { shipmentId, refType }
 *   taiWebhookLogs/{auto}            - delivery audit (TAI does not retry)
 *
 * Environment variables:
 *   TAI_WEBHOOK_SECRET - shared secret expected in the Authorization header
 *                        (configured on the TAI Source Setting). If unset,
 *                        auth is skipped (NOT recommended for production).
 *
 * Exports (re-exported from index.js so Firebase deploys them):
 *   taiWebhook          - onRequest, the receiver TAI POSTs to
 *   taiResolveShipment  - onRequest, debug/utility lookup by load or PRO
 */

"use strict";

const {onRequest} = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

/** The tenant this file is dedicated to. */
const CTC_TENANT_ID = "coast_to_coast";

/**
 * Returns the Firestore client. Lazily resolved so this module can be
 * required before admin.initializeApp() runs in index.js.
 * @return {FirebaseFirestore.Firestore} Firestore instance.
 */
function db() {
  return admin.firestore();
}

/**
 * Returns a tenant-scoped collection reference. Routes through the shared
 * `tcol` helper (injected from index.js) so the TAI workflow reads and writes
 * EXACTLY the same prefixed collections the intake pipeline used for that
 * tenant — e.g. `coast_to_coast_invoices`. With no tenant (or the default
 * tenant, whose prefix is ""), this is the unprefixed collection, preserving
 * legacy behavior. Using one shared prefixing helper (rather than a private
 * copy) is itself a safety property: intake, workflow, and dashboard can never
 * disagree about where a tenant's data lives.
 * @param {object|null} tenant Tenant config, or null for the default scope.
 * @param {string} name Base collection name.
 * @return {FirebaseFirestore.CollectionReference} Scoped collection ref.
 */
function tcolFor(tenant, name) {
  if (tenant && shared && typeof shared.tcol === "function") {
    return shared.tcol(tenant, name);
  }
  return db().collection(name);
}

/**
 * Resolves a tenant config by id via the injected getTenant helper. Returns
 * null if the shared bundle is unavailable (helpers not injected yet).
 * @param {string|null} tenantId Tenant identifier.
 * @return {Promise<object|null>} Tenant config or null.
 */
async function resolveTenant(tenantId) {
  if (shared && typeof shared.getTenant === "function") {
    return shared.getTenant(tenantId || "default");
  }
  return null;
}

/**
 * Writes a lightweight audit log for webhook activity. TAI delivers each
 * event only once (no retries), so we always record the outcome.
 * @param {string} level Log level (info, warn, error).
 * @param {string} message Human-readable message.
 * @param {object} [details] Additional structured detail.
 * @param {object|null} [tenant] Owning tenant, for collection scoping.
 * @return {Promise<void>}
 */
async function logWebhook(level, message, details = {}, tenant = null) {
  try {
    const clean = JSON.parse(JSON.stringify(details, (key, value) => {
      return value === undefined ? null : value;
    }));
    await tcolFor(tenant, "taiWebhookLogs").add({
      level,
      message,
      details: clean,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error(`[tai] failed to write webhook log: ${error.message}`);
    console.log(`[${level.toUpperCase()}] tai: ${message}`, details);
  }
}

/**
 * Normalizes a reference value into a stable lookup key: uppercased with
 * spaces and dashes stripped. Mirrors normalizeLoadNumber() in index.js so
 * the workflow and the index agree on keys.
 * @param {string|number|null|undefined} value Raw reference value.
 * @return {string} Normalized key, or "" if empty.
 */
function normalizeRefKey(value) {
  return String(value == null ? "" : value)
      .replace(/[\s-]/g, "")
      .trim()
      .toUpperCase();
}

/**
 * Reference types (by TAI name) that are worth indexing for matching a
 * carrier invoice back to a shipment. We index the shipmentId itself plus
 * any of these reference numbers that appear on the shipment or its stops.
 * Unknown/custom types are still indexed (see indexShipment) — this list is
 * only used to tag well-known types in the lookup doc.
 * @type {Set<string>}
 */
const KNOWN_REF_TYPES = new Set([
  "ReferenceNumber",
  "Reference Number",
  "ShipperReferenceNumber",
  "Shipper Reference Number",
  "PONumber",
  "Customer PO Number",
  "InvoiceNumber",
  "Invoice Number",
  "SecondaryBOLNumber",
  "Secondary BOL Number",
  "LinehaulCarrierProNumber",
  "Linehaul Carrier Pro Number",
  "PickupCarrierProNumber",
  "DeliveryCarrierProNumber",
  "ConsolidationCarrierProNumber",
  "ExternalBillNumber",
]);

/**
 * Collects all indexable reference values from a ShipmentDetails payload:
 * the shipmentId, shipment-level reference numbers, and stop-level reference
 * numbers. Each entry is { key, refType, rawValue }.
 * @param {object} shipment ShipmentDetails payload from a webhook.
 * @return {Array<{key: string, refType: string, rawValue: string}>} Entries.
 */
function collectReferenceEntries(shipment) {
  const entries = [];
  const push = (refType, rawValue) => {
    const key = normalizeRefKey(rawValue);
    if (!key) return;
    entries.push({key, refType: refType || "Unknown", rawValue: rawValue});
  };

  // The shipmentId itself — a carrier invoice sometimes quotes it directly.
  if (shipment.shipmentId != null) {
    push("ShipmentId", String(shipment.shipmentId));
  }

  const shipmentRefs = Array.isArray(shipment.shipmentReferenceNumbers) ?
    shipment.shipmentReferenceNumbers : [];
  for (const ref of shipmentRefs) {
    if (ref && ref.value != null) push(ref.referenceType, ref.value);
  }

  const stops = Array.isArray(shipment.stops) ? shipment.stops : [];
  for (const stop of stops) {
    if (!stop) continue;
    if (stop.referenceNumber != null) {
      push("StopReferenceNumber", stop.referenceNumber);
    }
    const stopRefs = Array.isArray(stop.shipmentStopReferenceNumbers) ?
      stop.shipmentStopReferenceNumbers : [];
    for (const ref of stopRefs) {
      if (ref && ref.value != null) push(ref.referenceType, ref.value);
    }
  }

  return entries;
}

/**
 * Extracts a compact, workflow-relevant snapshot from a ShipmentDetails
 * payload. Storing the full payload is fine too, but the snapshot keeps the
 * fields the invoice workflow actually consumes close at hand.
 * @param {object} shipment ShipmentDetails payload.
 * @return {object} Snapshot object.
 */
function buildSnapshot(shipment) {
  const carrierList = Array.isArray(shipment.carrierList) ?
    shipment.carrierList : [];
  const stops = Array.isArray(shipment.stops) ? shipment.stops : [];
  const deliveryStop = stops.find((s) => s && s.stopType === "Delivery") ||
    (stops.length ? stops[stops.length - 1] : null);

  return {
    shipmentId: shipment.shipmentId != null ?
      Number(shipment.shipmentId) : null,
    status: shipment.status || null,
    shipmentType: shipment.shipmentType || null,
    totalBuy: shipment.totalBuy != null ? Number(shipment.totalBuy) : null,
    totalSell: shipment.totalSell != null ? Number(shipment.totalSell) : null,
    customerName: (shipment.customer && shipment.customer.name) || null,
    billToOrganizationId:
      (shipment.customer && shipment.customer.billToOrganizationId) || null,
    payerOrganizationId:
      (shipment.payerOrganization &&
        shipment.payerOrganization.organizationId) || null,
    carrier: carrierList.length ? {
      carrierMasterId: carrierList[0].carrierMasterId || null,
      name: carrierList[0].name || null,
      transitType: carrierList[0].transitType || null,
      buy: carrierList[0].buy != null ? Number(carrierList[0].buy) : null,
    } : null,
    deliveryStopId: deliveryStop ? deliveryStop.shipmentStopId || null : null,
    hasAttachments: Array.isArray(shipment.attachments) &&
      shipment.attachments.length > 0,
  };
}

/**
 * Upserts a shipment snapshot and all of its reference-number lookup keys.
 * Idempotent: TAI fires ShipmentDetailUpdateUrl repeatedly over a shipment's
 * life, so we always overwrite with the latest state.
 * @param {object} shipment ShipmentDetails payload.
 * @param {string} eventType Webhook event label (for audit).
 * @param {object|null} [tenant] Owning tenant, for collection scoping.
 * @return {Promise<{shipmentId: number, indexed: number}>} Result.
 */
async function indexShipment(shipment, eventType, tenant = null) {
  const shipmentId = Number(shipment.shipmentId);
  if (!Number.isFinite(shipmentId) || shipmentId <= 0) {
    throw new Error("Payload missing a valid shipmentId");
  }

  const snapshot = buildSnapshot(shipment);
  const entries = collectReferenceEntries(shipment);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const batch = db().batch();

  const shipmentRef =
    tcolFor(tenant, "taiShipments").doc(String(shipmentId));
  batch.set(shipmentRef, {
    ...snapshot,
    tenantId: (tenant && tenant.tenantId) || "default",
    lastEvent: eventType || null,
    referenceKeys: entries.map((e) => e.key),
    raw: shipment,
    updatedAt: now,
  }, {merge: true});

  for (const entry of entries) {
    const lookupRef = tcolFor(tenant, "taiShipmentLookups").doc(entry.key);
    batch.set(lookupRef, {
      shipmentId: shipmentId,
      tenantId: (tenant && tenant.tenantId) || "default",
      refType: entry.refType,
      refTypeKnown: KNOWN_REF_TYPES.has(entry.refType),
      rawValue: entry.rawValue,
      updatedAt: now,
    }, {merge: true});
  }

  await batch.commit();
  return {shipmentId, indexed: entries.length};
}

/**
 * Validates the Authorization header against TAI_WEBHOOK_SECRET. If the env
 * var is unset, auth is skipped (returns true) and a warning is logged.
 * @param {object} req Express-style request.
 * @return {boolean} True if the request is authorized.
 */
function isAuthorized(req) {
  const expected = process.env.TAI_WEBHOOK_SECRET_COAST_TO_COAST ||
    process.env.TAI_WEBHOOK_SECRET;
  if (!expected) {
    console.warn(
        "[ctc-tai] webhook secret not set — skipping auth check");
    return true;
  }
  const header = req.get("authorization") || req.get("Authorization") || "";
  // Accept either the raw secret or a "Bearer <secret>" form.
  const provided = header.replace(/^Bearer\s+/i, "").trim();
  return provided === expected;
}

/**
 * Resolves the ShipmentDetails object from a webhook body. Shipment events
 * send ShipmentDetails directly; InvoiceCreateWithShipmentUrl wraps it under
 * `shipmentDetails`. Returns null if no shipment data is present.
 * @param {object} body Parsed request body.
 * @return {object|null} ShipmentDetails-like object, or null.
 */
function extractShipmentDetails(body) {
  if (!body || typeof body !== "object") return null;
  if (body.shipmentId != null && body.status !== undefined) return body;
  if (body.shipmentDetails && typeof body.shipmentDetails === "object") {
    return body.shipmentDetails;
  }
  // Some shipment payloads omit status but still carry shipmentId + refs.
  if (body.shipmentId != null &&
      Array.isArray(body.shipmentReferenceNumbers)) {
    return body;
  }
  return null;
}

/**
 * TAI webhook receiver.
 *
 * Configure these TAI Source Setting URL parameters to point here (optionally
 * with ?event=<name> so the audit log is labeled):
 *   ShipmentCreateUrl            -> .../taiWebhook?event=ShipmentCreate
 *   ShipmentDetailUpdateUrl      -> .../taiWebhook?event=ShipmentDetailUpdate
 *   ShipmentStatusUpdateUrl      -> .../taiWebhook?event=ShipmentStatusUpdate
 *   InvoiceCreateWithShipmentUrl -> .../taiWebhook?event=InvoiceCreate
 * Set the Source Setting Authorization parameter to TAI_WEBHOOK_SECRET.
 *
 * Responds 200 quickly and does the (small) indexing work inline. TAI uses a
 * ~100s client timeout and never retries, so we must not hang.
 */
exports.ctcTaiWebhook = onRequest(
    {timeoutSeconds: 60, memory: "256MiB"},
    async (req, res) => {
      const eventType = (req.query && req.query.event) ?
        String(req.query.event) : "Unknown";

      // Which tenant this shipment belongs to. TAI posts to a per-tenant URL
      // (configure the Source Setting as .../taiWebhook?tenant=<id>&event=...).
      // The tenant namespaces the shipment index so two TAI companies sharing
      // this deployment can never resolve each other's load numbers.
      const tenantId = (req.query && req.query.tenant) ?
        String(req.query.tenant) : CTC_TENANT_ID;
      const tenant = await resolveTenant(tenantId);

      if (req.method !== "POST") {
        return res.status(405).json({
          ok: false,
          error: "Method not allowed. Use POST.",
        });
      }

      if (!isAuthorized(req)) {
        await logWebhook("warn", "Rejected unauthorized webhook",
            {eventType, tenantId}, tenant);
        return res.status(401).json({ok: false, error: "Unauthorized"});
      }

      const body = req.body || {};
      const shipment = extractShipmentDetails(body);

      // No shipment data (e.g. a customer/carrier-only event). Acknowledge so
      // TAI does not log a delivery failure, but record that we skipped it.
      if (!shipment) {
        await logWebhook("info", "Webhook had no shipment payload to index", {
          eventType,
          tenantId,
          bodyKeys: Object.keys(body),
        }, tenant);
        return res.status(200).json({ok: true, indexed: false});
      }

      try {
        const result = await indexShipment(shipment, eventType, tenant);
        await logWebhook("info", "Indexed shipment from webhook", {
          eventType,
          tenantId,
          shipmentId: result.shipmentId,
          referenceKeysIndexed: result.indexed,
          status: shipment.status || null,
        }, tenant);
        return res.status(200).json({
          ok: true,
          indexed: true,
          shipmentId: result.shipmentId,
          referenceKeysIndexed: result.indexed,
        });
      } catch (error) {
        await logWebhook("error", "Failed to index shipment webhook", {
          eventType,
          tenantId,
          error: error.message,
          shipmentId: shipment.shipmentId || null,
        }, tenant);
        // Return 200 anyway: TAI will not retry, and a 500 just creates a
        // failure log on their side without changing the outcome. The error
        // is captured in taiWebhookLogs for our own reconciliation.
        return res.status(200).json({ok: false, error: error.message});
      }
    },
);

/**
 * Resolves a TAI shipmentId from a load number and/or PRO number using the
 * lookup index built by the webhook receiver. Tries PRO first (most specific
 * to a carrier invoice), then load number, then the raw value as a
 * shipmentId. Intended for use by the invoice workflow.
 * @param {object} args Lookup arguments.
 * @param {string|number|null} [args.loadNumber] Load/BOL number.
 * @param {string|number|null} [args.proNumber] Carrier PRO number.
 * @return {Promise<object>} Resolution result with keys: found, shipmentId,
 *   matchedBy, snapshot.
 */
async function resolveTaiShipmentId({loadNumber, proNumber, tenant} = {}) {
  const candidates = [
    {source: "proNumber", key: normalizeRefKey(proNumber)},
    {source: "loadNumber", key: normalizeRefKey(loadNumber)},
  ].filter((c) => c.key);

  for (const candidate of candidates) {
    const lookupSnap = await tcolFor(tenant, "taiShipmentLookups")
        .doc(candidate.key)
        .get();
    if (lookupSnap.exists) {
      const data = lookupSnap.data() || {};
      const shipmentId = Number(data.shipmentId);
      let snapshot = null;
      if (Number.isFinite(shipmentId)) {
        const shipSnap = await tcolFor(tenant, "taiShipments")
            .doc(String(shipmentId))
            .get();
        snapshot = shipSnap.exists ? shipSnap.data() : null;
      }
      return {
        found: true,
        shipmentId: Number.isFinite(shipmentId) ? shipmentId : null,
        matchedBy: `${candidate.source}:${data.refType || "Unknown"}`,
        snapshot,
      };
    }
  }

  return {found: false, shipmentId: null, matchedBy: null, snapshot: null};
}

exports.resolveTaiShipmentId = resolveTaiShipmentId;

/**
 * Debug / utility HTTP endpoint to resolve a shipmentId from a load or PRO
 * number. Useful for testing the index and for manual reconciliation.
 * Query/body params: loadNumber, proNumber.
 */
exports.ctcTaiResolveShipment = onRequest(
    {timeoutSeconds: 30, memory: "256MiB"},
    async (req, res) => {
      const src = req.method === "POST" ? (req.body || {}) : (req.query || {});
      const loadNumber = src.loadNumber || null;
      const proNumber = src.proNumber || null;
      const tenant = await resolveTenant(
          src.tenantId || src.tenant || CTC_TENANT_ID);

      if (!loadNumber && !proNumber) {
        return res.status(400).json({
          ok: false,
          error: "Provide loadNumber and/or proNumber.",
        });
      }

      try {
        const result = await resolveTaiShipmentId(
            {loadNumber, proNumber, tenant});
        return res.status(result.found ? 200 : 404).json({
          ok: result.found,
          ...result,
        });
      } catch (error) {
        return res.status(500).json({ok: false, error: error.message});
      }
    },
);

// ─────────────────────────────────────────────────────────────────────────
// Shared workflow helpers (injected from index.js)
//
// The orchestration around the TMS (pause emails, workflow step logging, POD
// extraction, customer-invoice PDF building) is identical regardless of which
// TMS a client runs on. Rather than duplicate ~1400 lines from the Primus
// workflow, index.js injects those helpers here via init(). Only the TAI API
// calls in this file are TMS-specific.
// ─────────────────────────────────────────────────────────────────────────

/** @type {object|null} Injected shared helper bundle. */
let shared = null;

/**
 * Receives the shared helper bundle from index.js. Must be called once at
 * module load (index.js does this immediately after require("./tai")).
 * @param {object} bundle Shared helpers and Firestore handles.
 * @return {void}
 */
function init(bundle) {
  shared = bundle;
}
exports.init = init;

/**
 * Returns the shared helper bundle or throws if init() was never called.
 * @return {object} The shared bundle.
 */
function s() {
  if (!shared) {
    throw new Error("tai.js used before init() — call tai.init(bundle).");
  }
  return shared;
}

// ─────────────────────────────────────────────────────────────────────────
// TAI REST API client
// ─────────────────────────────────────────────────────────────────────────

/**
 * Makes an authenticated request to the TAI Public API.
 *
 * Auth uses the `x-api-key` header (per the OpenAPI security scheme). Set
 * TAI_BASE_URL (e.g. https://www.taibeta.net) and TAI_API_KEY. Mirrors the
 * semantics of primusRequest in index.js: 204 -> {ok:true}, 404 -> null,
 * other non-2xx -> throw.
 * @param {string} method HTTP method.
 * @param {string} path API path appended to TAI_BASE_URL (starts with /).
 * @param {object} [body] Optional JSON request body.
 * @return {Promise<object|Array|string|null>} Parsed response, or null on 404.
 */
async function taiRequest(method, path, body) {
  const base = process.env.TAI_BASE_URL_COAST_TO_COAST ||
    process.env.TAI_BASE_URL || "https://www.taibeta.net";
  const headers = {
    "x-api-key": process.env.TAI_API_KEY_COAST_TO_COAST ||
      process.env.TAI_API_KEY || "",
    "Content-Type": "application/json",
    "accept": "application/json",
  };
  const opts = {method, headers};
  if (body !== undefined) opts.body = JSON.stringify(body);

  const resp = await fetch(`${base}${path}`, opts);
  if (resp.status === 204) return {ok: true};
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`TAI ${method} ${path} -> ${resp.status}: ${txt}`);
  }
  const text = await resp.text();
  if (!text) return {ok: true};
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}
exports.taiRequest = taiRequest;

/**
 * GET full shipment details by shipmentId.
 * @param {number|string} shipmentId Shipment ID.
 * @return {Promise<object|null>} ShipmentDetails or null.
 */
function getTaiShipmentDetails(shipmentId) {
  return taiRequest(
      "GET", `/PublicApi/Shipping/v2/Shipments/${shipmentId}`);
}

/**
 * GET pricing details (buy/sell breakdown) by shipmentId.
 * @param {number|string} shipmentId Shipment ID.
 * @return {Promise<object|null>} Pricing details or null.
 */
function getTaiPricingDetails(shipmentId) {
  return taiRequest(
      "GET", `/PublicApi/Shipping/v2/pricingdetail/${shipmentId}`);
}
exports.getTaiPricingDetails = getTaiPricingDetails;

/**
 * GET shipment-level reference numbers.
 * @param {number|string} shipmentId Shipment ID.
 * @return {Promise<Array|null>} Array of {referenceType, value} or null.
 */
function getTaiReferenceNumbers(shipmentId) {
  return taiRequest(
      "GET",
      `/PublicApi/Shipping/v2/ShipmentReferenceNumbers?shipmentId=` +
      `${encodeURIComponent(shipmentId)}`);
}

/**
 * PUT (add/update) shipment-level reference numbers.
 * @param {number|string} shipmentId Shipment ID.
 * @param {Array<object>} refs Array of {referenceType, value}.
 * @return {Promise<object|Array|null>} API response.
 */
function putTaiReferenceNumbers(shipmentId, refs) {
  return taiRequest(
      "PUT",
      `/PublicApi/Shipping/v2/ShipmentReferenceNumbers?shipmentId=` +
      `${encodeURIComponent(shipmentId)}`,
      refs);
}

/**
 * PUT stop dates + POD for a single stop.
 * @param {number|string} shipmentStopId Shipment stop ID.
 * @param {object} body PublicAPIShipmentTrackingUpdateShort body.
 * @return {Promise<object|Array|null>} API response.
 */
function putTaiStopDatesAndPod(shipmentStopId, body) {
  return taiRequest(
      "PUT", `/PublicApi/Shipping/v2/Tracking/${shipmentStopId}`, body);
}

/**
 * POST a shipment document attachment (e.g. POD).
 * @param {object} body PublicAPIDocumentAttachmentV2 body.
 * @return {Promise<object|null>} API response.
 */
function postTaiDocument(body) {
  return taiRequest(
      "POST", `/PublicApi/Shipping/v2/DocumentAttachments`, body);
}

/**
 * GET accounting bills for a shipment.
 * @param {number|string} shipmentId Shipment ID.
 * @return {Promise<Array|null>} Array of PublicAPIBill or null.
 */
function getTaiBillsByShipment(shipmentId) {
  return taiRequest(
      "GET", `/PublicApi/Accounting/v2/Bills/Shipment/${shipmentId}`);
}

/**
 * POST approve a carrier bill.
 * @param {object} body PublicAPIApproveBill body.
 * @return {Promise<object|null>} API response.
 */
function postTaiApproveBill(body) {
  return taiRequest("POST", `/PublicApi/Accounting/v2/Bills/Approve`, body);
}

/**
 * POST send an unapproved bill to variance.
 * @param {object} body Variance body (shipmentId, vendorId, etc.).
 * @return {Promise<object|null>} API response.
 */
function postTaiBillVariance(body) {
  return taiRequest("POST", `/PublicApi/Accounting/v2/Bills/Variance`, body);
}
exports.postTaiBillVariance = postTaiBillVariance;

/**
 * GET accounting invoices for a shipment.
 * @param {number|string} shipmentId Shipment ID.
 * @return {Promise<Array|null>} Array of PublicAPIInvoice or null.
 */
function getTaiInvoicesByShipment(shipmentId) {
  return taiRequest(
      "GET", `/PublicApi/Accounting/v2/Invoices/Shipment/${shipmentId}`);
}

/**
 * POST approve (finalize) a customer invoice for a shipment.
 * @param {object} body PublicAPIInvoiceCreateRequest body.
 * @return {Promise<object|null>} The created/approved PublicAPIInvoice.
 */
function postTaiApproveInvoice(body) {
  return taiRequest("POST", `/PublicApi/Accounting/v2/Invoices`, body);
}

// ─────────────────────────────────────────────────────────────────────────
// Workflow action functions (mirror the Primus helpers in index.js, but
// keyed by shipmentId instead of load number).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Reads the carrier cost (buy) for a shipment, preferring the cached webhook
 * snapshot and falling back to a live shipment fetch.
 * @param {number|string} shipmentId Shipment ID.
 * @param {object|null} snapshot Cached taiShipments snapshot, if available.
 * @return {Promise<number|null>} Carrier cost, or null if unknown.
 */
async function getCarrierCost(shipmentId, snapshot) {
  if (snapshot) {
    if (snapshot.carrier && snapshot.carrier.buy != null) {
      return Number(snapshot.carrier.buy);
    }
    if (snapshot.totalBuy != null) return Number(snapshot.totalBuy);
  }
  const details = await getTaiShipmentDetails(shipmentId);
  if (!details) return null;
  if (details.totalBuy != null) return Number(details.totalBuy);
  const carriers = Array.isArray(details.carrierList) ?
    details.carrierList : [];
  if (carriers.length && carriers[0].buy != null) {
    return Number(carriers[0].buy);
  }
  return null;
}

/**
 * Validates a carrier invoice amount against the shipment's carrier cost in
 * TAI. Same tolerance rule as the Primus path (±$0.50 or 2%).
 * @param {number|string} shipmentId Shipment ID.
 * @param {number} amount Invoice amount to validate.
 * @param {object|null} [snapshot] Cached snapshot for the shipment.
 * @return {Promise<object>} Validation result (matches Primus shape).
 */
async function validateAmountWithTai(shipmentId, amount, snapshot = null) {
  try {
    const carrierCost = await getCarrierCost(shipmentId, snapshot);
    if (!carrierCost || carrierCost <= 0) {
      return {
        ok: false,
        validAmount: false,
        error: "No carrier cost on TAI shipment",
      };
    }
    const diff = Math.abs(Number(amount) - carrierCost);
    const tolerance = Math.max(0.50, carrierCost * 0.02);
    const valid = diff <= tolerance;
    return {
      ok: true,
      validAmount: valid,
      amount: carrierCost,
      submittedAmount: Number(amount),
      savedAmount: carrierCost,
      difference: diff,
      proNumber: "",
      reason: valid ?
        "Amount matches" :
        `Submitted $${amount} vs TAI $${carrierCost} ` +
        `(diff $${diff.toFixed(2)})`,
    };
  } catch (error) {
    await s().writeLog("error", "tai", "Failed to validate amount with TAI", {
      shipmentId,
      amount,
      error: error.message,
    });
    return {ok: false, error: error.message};
  }
}
exports.validateAmountWithTai = validateAmountWithTai;

/**
 * Adds/updates the carrier PRO number (and optionally the carrier invoice
 * number) on a TAI shipment. Idempotent: skips the write if the PRO already
 * matches what is on file.
 * @param {number|string} shipmentId Shipment ID.
 * @param {string} proNumber PRO number to set.
 * @param {object} [invoiceData] Optional {invoiceNumber}.
 * @return {Promise<object>} Result {ok, skipped?, reason?, error?}.
 */
async function addProNumberToLoad(shipmentId, proNumber, invoiceData = {}) {
  try {
    if (!proNumber || String(proNumber).trim() === "") {
      return {ok: true, skipped: true, reason: "No PRO to write"};
    }
    const existing = await getTaiReferenceNumbers(shipmentId);
    const existingList = Array.isArray(existing) ? existing : [];
    const currentPro = existingList.find((r) => r &&
      /pro/i.test(String(r.referenceType || "")));
    if (currentPro &&
        normalizeRefKey(currentPro.value) === normalizeRefKey(proNumber)) {
      return {ok: true, skipped: true, reason: "PRO already set"};
    }

    const refs = [
      {referenceType: "LinehaulCarrierProNumber", value: String(proNumber)},
    ];
    if (invoiceData.invoiceNumber) {
      refs.push({
        referenceType: "InvoiceNumber",
        value: String(invoiceData.invoiceNumber),
      });
    }
    await putTaiReferenceNumbers(shipmentId, refs);
    return {ok: true};
  } catch (error) {
    await s().writeLog("error", "tai", "Failed to add PRO to TAI shipment", {
      shipmentId,
      proNumber,
      error: error.message,
    });
    return {ok: false, error: error.message};
  }
}
exports.addProNumberToLoad = addProNumberToLoad;

/**
 * Reads the customer name and sell rate for a shipment from TAI. Prefers the
 * cached webhook snapshot; falls back to a live fetch.
 * @param {number|string} shipmentId Shipment ID.
 * @param {object|null} [snapshot] Cached snapshot.
 * @return {Promise<object>} Result {ok, customerName, customerRate, error?}.
 */
async function getCustomerRate(shipmentId, snapshot = null) {
  try {
    let customerName = snapshot ? snapshot.customerName : null;
    let customerRate = snapshot && snapshot.totalSell != null ?
      Number(snapshot.totalSell) : null;

    if (!customerName || !customerRate) {
      const details = await getTaiShipmentDetails(shipmentId);
      if (details) {
        if (!customerName) {
          customerName = (details.customer && details.customer.name) || null;
        }
        if (!customerRate && details.totalSell != null) {
          customerRate = Number(details.totalSell);
        }
      }
    }

    if (!customerRate || customerRate <= 0) {
      return {ok: false, customerName, error: "No customer rate in TAI"};
    }
    return {ok: true, customerName, customerRate, rateSource: "totalSell"};
  } catch (error) {
    await s().writeLog("error", "tai", "Failed to get customer rate", {
      shipmentId,
      error: error.message,
    });
    return {ok: false, error: error.message};
  }
}
exports.getCustomerRate = getCustomerRate;

/**
 * Marks a shipment delivered by writing actual arrival/departure times and
 * the POD-signed-by name on the delivery stop. Treats a missing delivery stop
 * as a non-fatal skip. Note: the TAI tracking-short model labels the actual
 * date fields with a "pickup" prefix even though they apply to the addressed
 * stop; we set both so the stop is recorded as completed.
 * @param {number|string} shipmentId Shipment ID (for logging).
 * @param {object|null} snapshot Cached snapshot (provides deliveryStopId).
 * @param {object} [opts] Optional {signedBy, deliveredAt}.
 * @return {Promise<object>} Result {ok, alreadyDelivered?, skipped?, error?}.
 */
async function markShipmentDelivered(shipmentId, snapshot, opts = {}) {
  try {
    let stopId = snapshot ? snapshot.deliveryStopId : null;
    let status = snapshot ? snapshot.status : null;

    if (!stopId || !status) {
      const details = await getTaiShipmentDetails(shipmentId);
      if (details) {
        status = status || details.status;
        const stops = Array.isArray(details.stops) ? details.stops : [];
        const delivery = stops.find((x) => x && x.stopType === "Delivery") ||
          (stops.length ? stops[stops.length - 1] : null);
        if (delivery) {
          stopId = stopId || delivery.shipmentStopId;
          if (delivery.actualArrivalDateTime) {
            return {ok: true, alreadyDelivered: true};
          }
        }
      }
    }

    if (status && String(status).toLowerCase() === "delivered") {
      return {ok: true, alreadyDelivered: true};
    }
    if (!stopId) {
      return {ok: true, skipped: true, reason: "No delivery stop found"};
    }

    const when = opts.deliveredAt || new Date().toISOString();
    await putTaiStopDatesAndPod(stopId, {
      actualPickupArrivalDateTime: when,
      actualPickupDepartureDateTime: when,
      proofOfDeliverySignedBy: opts.signedBy || "POD on file",
    });
    return {ok: true, delivered: true};
  } catch (error) {
    await s().writeLog("error", "tai", "Failed to mark shipment delivered", {
      shipmentId,
      error: error.message,
    });
    return {ok: false, error: error.message};
  }
}
exports.markShipmentDelivered = markShipmentDelivered;

/**
 * Uploads a POD document to a TAI shipment.
 * @param {number|string} shipmentId Shipment ID.
 * @param {string} fileBase64 Base64-encoded PDF.
 * @param {string} fileName File name.
 * @return {Promise<object>} Result {ok, error?}.
 */
async function uploadPod(shipmentId, fileBase64, fileName) {
  try {
    if (!fileBase64) return {ok: true, skipped: true, reason: "No POD file"};
    await postTaiDocument({
      referenceNumbers: [
        {referenceType: "ShipmentId", value: String(shipmentId)},
      ],
      file: fileBase64,
      fileName: fileName || `pod-${shipmentId}.pdf`,
      attachmentType: "POD",
      accessLevel: "Private",
    });
    return {ok: true};
  } catch (error) {
    await s().writeLog("warn", "tai", "Failed to upload POD to TAI", {
      shipmentId,
      error: error.message,
    });
    return {ok: false, error: error.message};
  }
}
exports.uploadPod = uploadPod;

/**
 * Maps a shipment-level transit type to a TAI bill transitLegType enum.
 * @param {string|null} transitType Carrier transit type from the shipment.
 * @return {string} A valid PublicAPIApproveBill.transitLegType value.
 */
function mapTransitLegType(transitType) {
  const valid = new Set([
    "PickupLocal", "Linehaul", "DeliveryLocal", "Ocean", "Air", "Insurance",
    "Customs", "Lumper", "Warehouse", "Other", "Consolidation", "TONU",
  ]);
  if (transitType && valid.has(transitType)) return transitType;
  return "Linehaul";
}

/**
 * Approves the carrier bill for a shipment. Idempotent: if an approved bill
 * with a matching amount already exists, returns alreadyApproved.
 * @param {object} billData Bill data.
 * @param {number|string} billData.shipmentId Shipment ID.
 * @param {string} billData.invoiceNumber Carrier invoice/bill number.
 * @param {number} billData.invoiceAmount Bill amount.
 * @param {string} [billData.transitType] Carrier transit type.
 * @param {number} [billData.vendorId] Carrier vendor ID, if known.
 * @param {string} [billData.dueDate] Bill due date (ISO).
 * @return {Promise<object>} Result {ok, billId?, alreadyApproved?, error?}.
 */
async function approveCarrierBill(billData) {
  try {
    const shipmentId = billData.shipmentId;
    const amount = Number(billData.invoiceAmount || 0);

    const bills = await getTaiBillsByShipment(shipmentId);
    const list = Array.isArray(bills) ? bills : [];

    // Already approved? A bill that is not pending-unapproved and matches the
    // amount means the approval already happened.
    const approved = list.find((b) => b && b.pendingUnapprovedBills !== true &&
      Math.abs(Number(b.totalAmount || 0) - amount) <= 0.5);
    if (approved) {
      return {ok: true, alreadyApproved: true, billId: approved.billId};
    }

    // Try to recover the carrier vendorId from any existing (pending) bill.
    let vendorId = billData.vendorId || null;
    if (!vendorId) {
      const withVendor = list.find((b) => b && b.vendor && b.vendor.vendorId);
      if (withVendor) vendorId = withVendor.vendor.vendorId;
    }

    const body = {
      shipmentId: Number(shipmentId),
      vendorType: "Carrier",
      transitLegType: mapTransitLegType(billData.transitType),
      billNumber: String(billData.invoiceNumber || `LOAD-${shipmentId}`),
      billAmount: amount,
      billDate: billData.billDate || new Date().toISOString(),
      billDueDate: billData.dueDate ||
        new Date(Date.now() + 30 * 864e5).toISOString(),
    };
    if (vendorId) body.vendorId = Number(vendorId);

    const result = await postTaiApproveBill(body);
    const billId = result && (result.billId ||
      (result.data && result.data.billId)) || null;
    return {ok: true, billId};
  } catch (error) {
    await s().writeLog("error", "tai", "Failed to approve carrier bill", {
      shipmentId: billData.shipmentId,
      error: error.message,
    });
    return {ok: false, error: error.message};
  }
}
exports.approveCarrierBill = approveCarrierBill;

/**
 * Creates/approves the customer invoice for a shipment. Idempotent: if an
 * invoice already exists for the shipment it is reused, and its total is
 * sanity-checked against the expected customer rate.
 * @param {object} invoiceData Invoice data.
 * @param {number|string} invoiceData.shipmentId Shipment ID.
 * @param {number} invoiceData.customerRate Expected customer (sell) rate.
 * @return {Promise<object>} Result (matches the Primus generate shape).
 */
async function generateCustomerInvoice(invoiceData) {
  try {
    const shipmentId = invoiceData.shipmentId;
    const expectedRate = Number(invoiceData.customerRate || 0);

    // Idempotency: reuse an existing invoice rather than creating a duplicate.
    const existing = await getTaiInvoicesByShipment(shipmentId);
    const list = Array.isArray(existing) ? existing : [];
    if (list.length > 0) {
      const inv = list[0];
      const total = Number(inv.totalAmount || 0);
      if (expectedRate > 0 && Math.abs(total - expectedRate) > 0.5) {
        return {
          ok: false,
          error: `Invoice total ($${total}) does not match expected ` +
            `customer rate ($${expectedRate}). Refusing to proceed.`,
          customerInvoiceId: inv.invoiceId,
          invoiceTotal: total,
          expectedRate,
          difference: Math.abs(total - expectedRate),
        };
      }
      return {
        ok: true,
        reused: true,
        customerInvoiceId: inv.invoiceId,
        invoiceNumber: inv.invoiceNumber || null,
        invoiceTotal: total,
      };
    }

    // None yet — approve a new invoice for the shipment.
    const result = await postTaiApproveInvoice({
      shipmentId: Number(shipmentId),
      invoiceDate: new Date().toISOString(),
      markAsPrinted: false,
    });
    const inv = (result && result.invoiceId) ? result :
      (result && result.data ? result.data : null);
    if (!inv || !inv.invoiceId) {
      // Re-read to capture the freshly created invoice if POST returned bare.
      const reread = await getTaiInvoicesByShipment(shipmentId);
      const rlist = Array.isArray(reread) ? reread : [];
      if (rlist.length > 0) {
        return {
          ok: true,
          reused: false,
          customerInvoiceId: rlist[0].invoiceId,
          invoiceNumber: rlist[0].invoiceNumber || null,
          invoiceTotal: Number(rlist[0].totalAmount || 0),
        };
      }
      return {ok: false, error: "Invoice approval returned no ID", raw: result};
    }
    return {
      ok: true,
      reused: false,
      customerInvoiceId: inv.invoiceId,
      invoiceNumber: inv.invoiceNumber || null,
      invoiceTotal: Number(inv.totalAmount || 0),
    };
  } catch (error) {
    await s().writeLog("error", "tai", "Failed to generate customer invoice", {
      shipmentId: invoiceData.shipmentId,
      error: error.message,
    });
    return {ok: false, error: error.message};
  }
}
exports.generateCustomerInvoice = generateCustomerInvoice;

// ─────────────────────────────────────────────────────────────────────────
// Workflow orchestrator
// ─────────────────────────────────────────────────────────────────────────

/**
 * Loads the cached shipment snapshot for a shipmentId, if indexed.
 * @param {number|string} shipmentId Shipment ID.
 * @param {object|null} [tenant] Owning tenant, for collection scoping.
 * @return {Promise<object|null>} Snapshot data or null.
 */
async function loadSnapshot(shipmentId, tenant = null) {
  const snap = await tcolFor(tenant, "taiShipments")
      .doc(String(shipmentId))
      .get();
  return snap.exists ? snap.data() : null;
}

/**
 * Processes an invoice through the complete TAI workflow.
 *
 * This is the TAI equivalent of processPrimusWorkflow. It runs the same
 * decision sequence (resolve shipment, validate amount, write PRO, mark
 * delivered + POD, approve carrier bill, check customer rate/margin, create
 * customer invoice, email it) but calls the TAI API for every TMS action and
 * resolves the integer shipmentId via the webhook-built index first.
 *
 * Body: { invoiceId, resumeFrom? }.
 */
exports.processCtcTaiWorkflow = onRequest(
    {timeoutSeconds: 300, memory: "512MiB"},
    async (req, res) => {
      const h = s();
      try {
        if (req.method !== "POST") {
          return res.status(405).json({
            ok: false,
            error: "Method not allowed. Use POST.",
          });
        }

        const {invoiceId, tenantId} = req.body || {};
        if (!invoiceId) {
          return res.status(400).json({ok: false, error: "invoiceId required"});
        }

        // ── Tenant + TMS isolation gate ─────────────────────────────────────
        // Resolve the owning tenant and refuse to run unless it is a TAI
        // tenant. getTenant() is fail-closed: an unknown/missing tenant doc
        // resolves to the default Primus tenant, so this guard rejects rather
        // than risk running the TAI workflow against the wrong company. The
        // invoice is then read from the tenant's OWN prefixed collection — the
        // workflow physically cannot see another tenant's invoices.
        const tenant = await resolveTenant(tenantId || CTC_TENANT_ID);
        if (!tenant || String(tenant.tms).toLowerCase() !== "tai") {
          await h.writeLog("error", "workflow",
              "Refused TAI workflow for non-TAI tenant", {
                invoiceId,
                tenantId: tenantId || null,
                resolvedTms: tenant ? tenant.tms : null,
              });
          return res.status(400).json({
            ok: false,
            error: "WRONG_TMS",
            details: "This invoice's tenant is not configured for TAI.",
          });
        }

        // Bind this tenant as the ambient logging context so every
        // writeLog/logWorkflowStep below routes to THIS company's BigQuery
        // dataset and Firestore collections — never another company's.
        h.enterTenantContext(tenant);

        const invoiceRef = tcolFor(tenant, "invoices").doc(String(invoiceId));
        const invoiceDoc = await invoiceRef.get();
        if (!invoiceDoc.exists) {
          return res.status(404).json({ok: false, error: "Invoice not found"});
        }
        const invoice = invoiceDoc.data();

        // Defense in depth: the invoice doc is stamped with its tenantId/tms at
        // creation. Even if a misrouted request reached the right collection,
        // a mismatch here stops cross-company or cross-TMS processing.
        if (invoice.tenantId && invoice.tenantId !== tenant.tenantId) {
          await h.writeLog("error", "workflow",
              "Refused TAI workflow — invoice/tenant mismatch", {
                invoiceId,
                requestTenant: tenant.tenantId,
                invoiceTenant: invoice.tenantId,
              });
          return res.status(409).json({ok: false, error: "TENANT_MISMATCH"});
        }
        if (invoice.tms && String(invoice.tms).toLowerCase() !== "tai") {
          await h.writeLog("error", "workflow",
              "Refused TAI workflow — invoice is not a TAI invoice", {
                invoiceId,
                invoiceTms: invoice.tms,
              });
          return res.status(409).json({ok: false, error: "WRONG_TMS"});
        }

        if (invoice.finalWorkflowStatus === "completed") {
          return res.status(409).json({
            ok: false,
            error: "ALREADY_COMPLETED",
            customerInvoiceId: invoice.customerInvoiceId || null,
          });
        }

        const flowId = invoice.flowId || invoice.gmailMessageId || invoiceId;

        // Concurrency lock (same pattern as the Primus workflow).
        const lockAcquired = await db().runTransaction(async (tx) => {
          const snap = await tx.get(invoiceRef);
          if (!snap.exists) return false;
          const data = snap.data() || {};
          if (data.processingLock === true) return false;
          tx.update(invoiceRef, {
            processingLock: true,
            lastHeartbeatAt: h.FieldValue.serverTimestamp(),
            currentStep: "start",
            finalWorkflowStatus: "running",
            updatedAt: h.FieldValue.serverTimestamp(),
          });
          return true;
        });
        if (!lockAcquired) {
          return res.status(409).json({ok: false, error: "ALREADY_PROCESSING"});
        }

        await h.writeLog("info", "workflow", "Starting TAI workflow", {
          invoiceId,
          flowId,
          loadNumber: invoice.loadNumber,
          proNumber: invoice.proNumber || null,
          invoiceAmount: invoice.invoiceAmount || null,
        });

        const taiSteps = invoice.taiSteps || {
          shipmentResolved: false,
          amountValidated: false,
          proAdded: false,
          shipmentDelivered: false,
          billApproved: false,
          customerInvoiceGenerated: false,
        };

        // ── Step 0: resolve shipmentId via the webhook-built index ──────────
        await h.logWorkflowStep({
          invoiceId,
          stepName: "tai_shipment_resolve_started",
          stepStatus: "started",
          input: {loadNumber: invoice.loadNumber, proNumber: invoice.proNumber},
        });

        let shipmentId = invoice.taiShipmentId || null;
        if (!shipmentId) {
          const resolved = await resolveTaiShipmentId({
            loadNumber: invoice.loadNumber,
            proNumber: invoice.proNumber,
            tenant,
          });
          if (resolved.found) shipmentId = resolved.shipmentId;
        }

        if (!shipmentId) {
          await h.logWorkflowStep({
            invoiceId,
            stepName: "tai_shipment_resolve_failed",
            stepStatus: "stopped",
            reason: "Shipment not found in TAI index",
            error: "SHIPMENT_NOT_INDEXED",
          });
          await h.pauseWorkflow(
              invoiceRef,
              "resolve_shipment",
              "tai_shipment_not_found",
              "Could not match this invoice to a TAI shipment yet",
          );
          const baseUrl = `https://${req.get("host")}`;
          await h.saveOutboundEmail({
            tenant,
            type: "customer_missing",
            invoiceId,
            subject: `Action needed — No TAI shipment match for ` +
              `Load ${invoice.loadNumber}`,
            html:
              `<h2>TAI shipment not found</h2>` +
              `<p>No TAI shipment is indexed for load ` +
              `<strong>${h.escapeHtml(invoice.loadNumber || "")}</strong>` +
              (invoice.proNumber ?
                ` / PRO ${h.escapeHtml(invoice.proNumber)}` : "") +
              `. This usually means the shipment webhook has not arrived ` +
              `yet, or the reference number on the carrier invoice does not ` +
              `match TAI.</p>` +
              h.buildContinueButtonHtml(baseUrl, invoiceId),
          });
          return res.json({ok: true, workflowStatus: "tai_shipment_not_found"});
        }

        const snapshot = await loadSnapshot(shipmentId, tenant);
        taiSteps.shipmentResolved = true;
        await invoiceRef.update({
          taiShipmentId: Number(shipmentId),
          taiSteps,
          updatedAt: h.FieldValue.serverTimestamp(),
        });
        await h.setWorkflowHeartbeat(invoiceRef, "shipment_resolved");
        await h.logWorkflowStep({
          invoiceId,
          stepName: "tai_shipment_resolve_completed",
          stepStatus: "success",
          output: {shipmentId},
        });

        // ── Charge gates (identical to the Primus workflow) ─────────────────
        if (Array.isArray(invoice.unrecognizedCharges) &&
            invoice.unrecognizedCharges.length > 0) {
          await h.logWorkflowStep({
            invoiceId,
            stepName: "unrecognized_charges_check",
            stepStatus: "failed",
            reason: "Unrecognized charges detected",
            error: "UNRECOGNIZED_CHARGES",
          });
          await invoiceRef.update({
            decisionStage: "unrecognized_charges",
            decisionReason: "Unrecognized charges detected",
            processingLock: false,
            finalWorkflowStatus: "failed",
            updatedAt: h.FieldValue.serverTimestamp(),
          });
          return res.json({ok: false, error: "UNRECOGNIZED_CHARGES"});
        }

        if (Array.isArray(invoice.chargesNeedProof) &&
            invoice.chargesNeedProof.length > 0) {
          await h.logWorkflowStep({
            invoiceId,
            stepName: "charges_proof_check",
            stepStatus: "failed",
            reason: "Extra charges present with no proof",
            error: "CHARGES_NO_PROOF",
          });
          await invoiceRef.update({
            decisionStage: "charges_no_proof",
            decisionReason: "Extra charges present with no proof",
            processingLock: false,
            finalWorkflowStatus: "failed",
            updatedAt: h.FieldValue.serverTimestamp(),
          });
          return res.json({ok: false, error: "CHARGES_NO_PROOF"});
        }

        const proofRefs = Array.isArray(invoice.chargeProofRefs) ?
          invoice.chargeProofRefs : [];
        const attachments = Array.isArray(invoice.attachments) ?
          invoice.attachments : [];
        const approvedChargeProofFiles = proofRefs
            .map((ref) => {
              const att = attachments.find(
                  (a) => a && a.filename === ref.attachmentFilename);
              return {
                type: ref.type,
                amount: Number(ref.amount || 0),
                storagePath: (att && att.storagePath) || null,
              };
            })
            .filter((x) => x.storagePath);
        const approvedChargesTotal = approvedChargeProofFiles
            .reduce((sum, c) => sum + (Number(c.amount) || 0), 0);

        // ── POD extraction (shared helper) ──────────────────────────────────
        const extractedPod = await h.maybeExtractPodOnlyPdf(invoiceId, invoice);

        // ── Amount validation ───────────────────────────────────────────────
        await h.setWorkflowHeartbeat(invoiceRef, "amount_validation");
        const baseAmount = Number(invoice.invoiceAmount) - approvedChargesTotal;
        const amountValidation =
          await validateAmountWithTai(shipmentId, baseAmount, snapshot);

        await h.logWorkflowStep({
          invoiceId,
          stepName: "amount_validation_completed",
          stepStatus: amountValidation.ok && amountValidation.validAmount ?
            "success" : "failed",
          output: {
            validAmount: amountValidation.validAmount,
            submittedAmount: amountValidation.submittedAmount,
            taiAmount: amountValidation.savedAmount,
            difference: amountValidation.difference,
          },
          error: (amountValidation.ok && amountValidation.validAmount) ?
            null : (amountValidation.reason || "Amount validation failed"),
        });

        if (!amountValidation.ok || !amountValidation.validAmount) {
          await invoiceRef.update({
            decisionStage: "unmatched_amount",
            decisionReason: "Amount validation failed",
            baseAmountValidated: baseAmount,
            processingLock: false,
            finalWorkflowStatus: "failed",
            updatedAt: h.FieldValue.serverTimestamp(),
          });
          return res.json({
            ok: false,
            error: "UNMATCHED_AMOUNT",
            details: amountValidation,
          });
        }
        taiSteps.amountValidated = true;
        await invoiceRef.update({
          taiSteps,
          updatedAt: h.FieldValue.serverTimestamp(),
        });
        await h.setWorkflowHeartbeat(invoiceRef, "amount_validated");

        // Extra charges are never auto-invoiced — held for human review.
        if (approvedChargeProofFiles.length > 0) {
          await h.logWorkflowStep({
            invoiceId,
            stepName: "extra_charges_held_for_review",
            stepStatus: "failed",
            reason: "Extra charges require human approval before invoicing",
            error: "EXTRA_CHARGES_PENDING_REVIEW",
          });
          await h.pauseWorkflow(
              invoiceRef,
              "extra_charges",
              "extra_charges_pending_review",
              "Extra charges verified but held for human approval",
          );
          return res.json({ok: false, error: "EXTRA_CHARGES_PENDING_REVIEW"});
        }

        // ── PRO number ──────────────────────────────────────────────────────
        const workingProNumber = invoice.proNumber || null;
        if (workingProNumber) {
          const proResult = await addProNumberToLoad(
              shipmentId, workingProNumber,
              {invoiceNumber: invoice.invoiceNumber});
          await h.logWorkflowStep({
            invoiceId,
            stepName: "pro_added",
            stepStatus: proResult.ok ?
              (proResult.skipped ? "skipped" : "success") : "failed",
            output: proResult.ok ? {
              newPro: workingProNumber,
              skipped: proResult.skipped || false,
              reason: proResult.reason || null,
            } : null,
            error: proResult.ok ? null : "Failed to add PRO to TAI",
          });
          if (proResult.ok && !proResult.skipped) {
            taiSteps.proAdded = true;
            await invoiceRef.update({
              taiSteps,
              updatedAt: h.FieldValue.serverTimestamp(),
            });
          }
        }
        await h.setWorkflowHeartbeat(invoiceRef, "pro_added");

        // ── Mark delivered + upload POD ──────────────────────────────────────
        if (!taiSteps.shipmentDelivered) {
          const deliveredRes =
            await markShipmentDelivered(shipmentId, snapshot);
          const alreadyDelivered = h.isAlreadyDoneResult(deliveredRes);
          if (!deliveredRes.ok && !alreadyDelivered && !deliveredRes.skipped) {
            await invoiceRef.update({
              decisionStage: "mark_delivered_failed",
              decisionReason: "Failed to mark shipment delivered",
              processingLock: false,
              finalWorkflowStatus: "failed",
              updatedAt: h.FieldValue.serverTimestamp(),
            });
            return res.json({
              ok: false,
              error: "MARK_DELIVERED_FAILED",
              details: deliveredRes,
            });
          }
          taiSteps.shipmentDelivered = true;
          await invoiceRef.update({
            taiSteps,
            updatedAt: h.FieldValue.serverTimestamp(),
          });
          await h.logWorkflowStep({
            invoiceId,
            stepName: "shipment_mark_delivered_completed",
            stepStatus: "success",
            output: {alreadyDelivered, skipped: deliveredRes.skipped || false},
          });
        }

        const podStoragePath =
          (extractedPod && extractedPod.storagePath) ||
          (invoice.podOnlyFile && invoice.podOnlyFile.storagePath) || null;
        if (podStoragePath) {
          const podBase64 = await h.downloadStorageFileBase64(podStoragePath);
          if (podBase64) {
            await uploadPod(shipmentId, podBase64, `pod-${invoiceId}.pdf`);
          }
        }
        await h.setWorkflowHeartbeat(invoiceRef, "shipment_delivered");

        // ── Customer rate + test-customer pause ──────────────────────────────
        const rateResult = await getCustomerRate(shipmentId, snapshot);
        const customerName = rateResult.customerName || invoice.customerName;

        if (customerName &&
            String(customerName).toLowerCase().includes("test")) {
          await h.logWorkflowStep({
            invoiceId,
            stepName: "customer_check_paused",
            stepStatus: "stopped",
            reason: "Test customer detected - manual review required",
            error: "TEST_CUSTOMER",
          });
          await h.pauseWorkflow(
              invoiceRef,
              "check_customer",
              "test_customer_review",
              "Test customer detected - paused",
          );
          const baseUrl = `https://${req.get("host")}`;
          await h.saveOutboundEmail({
            tenant,
            type: "customer_missing",
            invoiceId,
            subject: "Customer requires confirmation",
            html: `<p>Invoice ${invoiceId} is for a test customer ` +
              `(${h.escapeHtml(customerName)}).</p>` +
              h.buildContinueButtonHtml(baseUrl, invoiceId),
          });
          return res.json({ok: true, workflowStatus: "test_customer_review"});
        }

        // ── Approve carrier bill ─────────────────────────────────────────────
        const approvalResult = await approveCarrierBill({
          shipmentId,
          invoiceNumber: invoice.invoiceNumber,
          invoiceAmount: invoice.invoiceAmount,
          transitType: snapshot && snapshot.carrier ?
            snapshot.carrier.transitType : null,
          dueDate: invoice.dueDate || null,
        });
        const billOk =
          approvalResult.ok || h.isAlreadyDoneResult(approvalResult);
        await h.logWorkflowStep({
          invoiceId,
          stepName: "bill_approval_completed",
          stepStatus: billOk ? "success" : "failed",
          output: billOk ? {
            billId: approvalResult.billId,
            alreadyApproved: approvalResult.alreadyApproved || false,
          } : null,
          error: billOk ? null : "Carrier bill approval failed",
        });
        if (!billOk) {
          await invoiceRef.update({
            decisionStage: "approval_failed",
            decisionReason: "Carrier bill approval failed",
            processingLock: false,
            finalWorkflowStatus: "failed",
            updatedAt: h.FieldValue.serverTimestamp(),
          });
          return res.json({
            ok: false,
            error: "Carrier bill approval failed",
            details: approvalResult,
          });
        }
        taiSteps.billApproved = true;
        await invoiceRef.update({
          taiSteps,
          updatedAt: h.FieldValue.serverTimestamp(),
        });
        await h.setWorkflowHeartbeat(invoiceRef, "bill_approved");

        // ── Customer rate / margin gate ──────────────────────────────────────
        if (!rateResult.ok) {
          await h.logWorkflowStep({
            invoiceId,
            stepName: "customer_rate_check_paused",
            stepStatus: "stopped",
            reason: "Missing customer rate",
            error: "MISSING_RATE",
          });
          await h.pauseWorkflow(
              invoiceRef, "get_rate", "needs_customer_rate_review",
              "Missing customer rate");
          const baseUrl = `https://${req.get("host")}`;
          await h.saveOutboundEmail({
            tenant,
            type: "rate_missing",
            invoiceId,
            subject: `Action needed — No customer rate for Load ` +
              `${invoice.loadNumber}`,
            html: `<h2>Customer Rate Missing</h2>` +
              `<p>No customer rate was found in TAI for load ` +
              `${h.escapeHtml(invoice.loadNumber || "")}.</p>` +
              `<a href="${baseUrl}/setCustomerRate?invoiceId=` +
              `${encodeURIComponent(invoiceId)}">Set Customer Rate</a>`,
          });
          return res.json({
            ok: true,
            workflowStatus: "needs_customer_rate_review",
          });
        }

        const manualRate = Number(invoice.customerRate || 0);
        const customerRate = manualRate || Number(rateResult.customerRate || 0);
        const carrierCost = Number(amountValidation.savedAmount || 0);
        const profit = customerRate - (carrierCost - approvedChargesTotal);
        const marginPct = customerRate > 0 ?
          Math.round((profit / customerRate) * 100) : 0;

        await invoiceRef.update({
          customerName,
          customerRate,
          profit,
          taiSteps,
          updatedAt: h.FieldValue.serverTimestamp(),
        });
        await h.setWorkflowHeartbeat(invoiceRef, "customer_rate_checked");

        if (!customerRate || customerRate <= 0 || profit < 10) {
          const pauseReason = !customerRate || customerRate <= 0 ?
            "Missing customer rate" : "Customer rate too low";
          await h.logWorkflowStep({
            invoiceId,
            stepName: "customer_rate_check_paused",
            stepStatus: "stopped",
            reason: pauseReason,
            output: {customerRate, profit},
            error: "LOW_MARGIN",
          });
          await h.pauseWorkflow(
              invoiceRef, "get_rate", "needs_customer_rate_review",
              pauseReason);
          const baseUrl = `https://${req.get("host")}`;
          await h.saveOutboundEmail({
            tenant,
            type: "rate_missing",
            invoiceId,
            subject: `Action needed — Low margin for Load ` +
              `${invoice.loadNumber}`,
            html: `<h2>Low Margin Warning — Load ` +
              `${h.escapeHtml(invoice.loadNumber || "")}</h2>` +
              `<p>Carrier cost $${Number(carrierCost).toFixed(2)}, ` +
              `customer rate $${Number(customerRate).toFixed(2)}, ` +
              `profit $${Number(profit).toFixed(2)} (${marginPct}%).</p>` +
              `<a href="${baseUrl}/setCustomerRate?invoiceId=` +
              `${encodeURIComponent(invoiceId)}">Update Customer Rate</a>`,
          });
          return res.json({
            ok: true,
            workflowStatus: "needs_customer_rate_review",
          });
        }

        // ── Generate customer invoice (idempotent) ───────────────────────────
        let invoiceGen = null;
        if (invoice.customerInvoiceId) {
          taiSteps.customerInvoiceGenerated = true;
          await invoiceRef.update({
            taiSteps,
            updatedAt: h.FieldValue.serverTimestamp(),
          });
        } else {
          invoiceGen = await generateCustomerInvoice({
            shipmentId,
            customerRate,
          });
          await h.logWorkflowStep({
            invoiceId,
            stepName: "customer_invoice_generation_completed",
            stepStatus: invoiceGen.ok ? "success" : "failed",
            output: invoiceGen.ok ?
              {customerInvoiceId: invoiceGen.customerInvoiceId} : null,
            error: invoiceGen.ok ? null : "Customer invoice generation failed",
          });
          if (!invoiceGen.ok) {
            await invoiceRef.update({
              processingLock: false,
              finalWorkflowStatus: "needs_invoice_review",
              decisionStage: "invoice_generation_failed",
              decisionReason: invoiceGen.error ||
                "Customer invoice generation failed",
              updatedAt: h.FieldValue.serverTimestamp(),
            });
            const baseUrl = `https://${req.get("host")}`;
            await h.saveOutboundEmail({
              tenant,
              type: "invoice_generation_failed",
              invoiceId,
              subject: `Action needed — Invoice issue on Load ` +
                `${invoice.loadNumber}`,
              html: `<h2>Invoice generation issue — Load ` +
                `${h.escapeHtml(invoice.loadNumber || "")}</h2>` +
                `<p>${h.escapeHtml(invoiceGen.error || "")}</p>` +
                `<a href="${baseUrl}/setCustomerRate?invoiceId=` +
                `${encodeURIComponent(invoiceId)}">Resume Workflow</a>`,
            });
            return res.json({
              ok: false,
              error: "Customer invoice generation failed",
              details: invoiceGen,
            });
          }
          taiSteps.customerInvoiceGenerated = true;
          await invoiceRef.update({
            taiSteps,
            customerInvoiceId: invoiceGen.customerInvoiceId,
            updatedAt: h.FieldValue.serverTimestamp(),
          });
        }
        await h.setWorkflowHeartbeat(invoiceRef, "customer_invoice_generated");

        const finalCustomerInvoiceId =
          (invoiceGen && invoiceGen.customerInvoiceId) ||
          invoice.customerInvoiceId || null;

        // ── Build + send the customer invoice email ──────────────────────────
        const pdfBase64 = await h.buildCustomerInvoicePdfBase64({
          invoiceId,
          loadNumber: invoice.loadNumber,
          proNumber: workingProNumber,
          customerName,
          customerRate,
          carrierInvoiceAmount: invoice.invoiceAmount,
        });
        const attachmentsToSend = [{
          filename: `customer-invoice-${invoiceId}.pdf`,
          contentType: "application/pdf",
          contentBase64: pdfBase64,
        }];
        if (podStoragePath) {
          const podBase64 = await h.downloadStorageFileBase64(podStoragePath);
          if (podBase64) {
            attachmentsToSend.push({
              filename: `pod-${invoiceId}.pdf`,
              contentType: "application/pdf",
              contentBase64: podBase64,
            });
          }
        }

        await h.saveOutboundEmail({
          tenant,
          type: "generated_bill",
          invoiceId,
          subject: `Invoice — Load ${invoice.loadNumber}` +
            (workingProNumber ? ` / PRO ${workingProNumber}` : ""),
          html: `<p>Dear ${h.escapeHtml(customerName)},</p>` +
            `<p>Please find attached your invoice for load ` +
            `<strong>${h.escapeHtml(invoice.loadNumber)}</strong>.</p>` +
            `<p>Amount: <strong>$${Number(customerRate).toFixed(2)}` +
            `</strong></p><p>Thank you for your business.</p>`,
          attachments: attachmentsToSend,
        });

        await invoiceRef.update({
          decisionStage: "completed",
          decisionReason: "TAI workflow completed successfully",
          customerName,
          customerRate,
          profit,
          taiSteps,
          finalWorkflowStatus: "completed",
          customerInvoiceId: finalCustomerInvoiceId,
          processingLock: false,
          updatedAt: h.FieldValue.serverTimestamp(),
        });

        await h.logWorkflowStep({
          invoiceId,
          stepName: "workflow_completed",
          stepStatus: "success",
          output: {customerName, profit, customerInvoiceId:
            finalCustomerInvoiceId},
        });
        await h.writeLog("info", "workflow", "TAI workflow completed", {
          invoiceId,
          flowId,
          shipmentId,
          loadNumber: invoice.loadNumber,
          customerName,
          customerRate,
          profit,
          marginPct,
          customerInvoiceId: finalCustomerInvoiceId,
        });

        return res.json({
          ok: true,
          message: "TAI workflow completed successfully",
          shipmentId,
          customerName,
          customerRate,
          profit,
          customerInvoiceId: finalCustomerInvoiceId,
          workflowStatus: "completed",
        });
      } catch (error) {
        const invoiceId = (req.body && req.body.invoiceId) || null;
        const tenantId = (req.body && req.body.tenantId) || null;
        try {
          await h.logWorkflowStep({
            invoiceId,
            stepName: "workflow_failed",
            stepStatus: "failed",
            reason: error.message,
            error: error.message,
          });
          await h.writeLog("error", "workflow", "TAI workflow failed", {
            invoiceId,
            error: error.message,
            stack: error.stack,
          });
          if (invoiceId) {
            // Re-resolve the tenant so the lock is released on the SAME
            // (prefixed) collection the workflow read from, never the root.
            const cleanupTenant = await resolveTenant(
                tenantId || CTC_TENANT_ID);
            const ref =
              tcolFor(cleanupTenant, "invoices").doc(String(invoiceId));
            const snap = await ref.get();
            if (snap.exists) {
              await ref.update({
                processingLock: false,
                finalWorkflowStatus: "failed",
                lastHeartbeatAt: h.FieldValue.serverTimestamp(),
                currentStep: (snap.data() || {}).currentStep || "failed",
                updatedAt: h.FieldValue.serverTimestamp(),
              });
            }
          }
        } catch (cleanupErr) {
          console.error("processTaiWorkflow cleanup failed:",
              cleanupErr.message);
        }
        console.error("processTaiWorkflow error:", error);
        return res.status(500).json({
          ok: false,
          error: "Internal server error.",
          details: error.message,
        });
      }
    },
);

// Exported for unit testing / reuse by the workflow.
exports._internal = {
  normalizeRefKey,
  collectReferenceEntries,
  buildSnapshot,
  extractShipmentDetails,
  mapTransitLegType,
};
