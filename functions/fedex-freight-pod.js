"use strict";

const DEFAULT_API_BASE =
  "https://api.ltl.tech/fxf-external-tracking-auth4/fxfgw/route";
const DEFAULT_ACCOUNT = "301105168";
const DEFAULT_CARRIER = "FDFR";

/**
 * @param {string|null|undefined} carrierName Carrier name from invoice.
 * @return {boolean}
 */
function isFedExFreightCarrier(carrierName) {
  return /fed\s*ex\s*freight/i.test(String(carrierName || ""));
}

/**
 * FedEx Freight PRO equals the carrier invoice / tracking number.
 * @param {object} args proNumber, invoiceNumber
 * @return {string|null} Digits-only PRO or null.
 */
function resolveFedExFreightPro(args) {
  const fields = [args && args.proNumber, args && args.invoiceNumber];
  for (const raw of fields) {
    const digits = String(raw || "").replace(/\D/g, "");
    if (digits.length >= 9 && digits.length <= 12) {
      return digits;
    }
  }
  return null;
}

/**
 * @param {string} pro Digits-only PRO.
 * @return {string}
 */
function fedExTrackingQualifier(pro) {
  return `~${pro}~${DEFAULT_CARRIER}`;
}

/**
 * @return {object} Request headers for FedEx Freight tracking API.
 */
function fedExApiHeaders() {
  return {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    "X-client-id": "FDXFWEB",
    "X-locale": "en_US",
    "X-version": "1.0.0",
  };
}

/**
 * @param {string} path API path beginning with /track/...
 * @param {object} body POST JSON body.
 * @return {Promise<object|null>}
 */
async function fedExPost(path, body) {
  const base = process.env.FEDEX_FREIGHT_API_BASE || DEFAULT_API_BASE;
  const url = `${base.replace(/\/$/, "")}${path}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: fedExApiHeaders(),
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    return {
      ok: false,
      status: resp.status,
      error: `Non-JSON response (${resp.status})`,
      raw: text.slice(0, 300),
    };
  }
  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      error: (json.errors && JSON.stringify(json.errors)) ||
        json.message ||
        `HTTP ${resp.status}`,
      json,
    };
  }
  return {ok: true, status: resp.status, json};
}

/**
 * Track a FedEx Freight PRO and return the first package row.
 * @param {string} pro Digits-only PRO.
 * @return {Promise<object|null>}
 */
async function trackFedExFreightShipment(pro) {
  const result = await fedExPost("/track/v2/track-shipments", {
    appDeviceType: "WTRK",
    appType: "WTRK",
    summaryView: false,
    supportHTML: true,
    supportCurrentLocation: true,
    uniqueKey: "",
    trackingInfo: [{
      trackNumberInfo: {
        trackingCarrier: DEFAULT_CARRIER,
        trackingNumber: pro,
        trackingQualifier: fedExTrackingQualifier(pro),
      },
    }],
  });
  if (!result.ok) {
    return {ok: false, error: result.error, status: result.status};
  }
  const pkg = result.json &&
    result.json.output &&
    result.json.output.packages &&
    result.json.output.packages[0];
  if (!pkg) {
    return {ok: false, error: "No shipment returned for PRO"};
  }
  return {
    ok: true,
    package: pkg,
    trackingNumber: pkg.trackingNbr || pro,
    trackingQualifier: pkg.trackingQualifier || fedExTrackingQualifier(pro),
    trackingCarrier: pkg.trackingCarrierCd || DEFAULT_CARRIER,
    ppodAvailable: pkg.ppodImageAvailable === true,
    keyStatus: pkg.keyStatusCD || null,
  };
}

/**
 * Download signed proof-of-delivery PDF bytes for a FedEx Freight PRO.
 * Mirrors fedexfreight.com: track → obtain proof of delivery → account → PDF.
 * @param {string} pro Digits-only PRO / invoice number.
 * @param {object} [opts] accountNumber
 * @return {Promise<object>}
 */
async function fetchFedExFreightPodPdf(pro, opts) {
  const proNumber = String(pro || "").replace(/\D/g, "");
  if (!proNumber) {
    return {ok: false, error: "Missing PRO number"};
  }
  const accountNumber = String(
      (opts && opts.accountNumber) ||
      process.env.FEDEX_FREIGHT_ACCOUNT_NUMBER ||
      DEFAULT_ACCOUNT,
  ).replace(/\D/g, "");
  if (!accountNumber) {
    return {ok: false, error: "Missing FedEx account number"};
  }

  const track = await trackFedExFreightShipment(proNumber);
  if (!track.ok) {
    return {ok: false, error: track.error || "Track lookup failed", proNumber};
  }

  const spodInfo = [{
    trackingNumber: track.trackingNumber,
    accountNbr: accountNumber,
    trackingQualifier: track.trackingQualifier,
    trackingCarrier: track.trackingCarrier,
  }];

  const docResult = await fedExPost("/track/v2/documents", {
    appDeviceType: "SPOD",
    appType: "SPOD",
    spodInfo,
    trackingNumber: null,
    accountNumber: null,
    type: null,
  });
  if (!docResult.ok) {
    return {
      ok: false,
      error: docResult.error || "POD document request failed",
      proNumber,
      accountNumber,
    };
  }

  const b64 = docResult.json &&
    docResult.json.output &&
    docResult.json.output.documentImage;
  if (!b64 || typeof b64 !== "string") {
    return {
      ok: false,
      error: "POD response missing documentImage",
      proNumber,
      accountNumber,
    };
  }

  const pdfBuffer = Buffer.from(b64, "base64");
  if (!pdfBuffer.length || pdfBuffer.slice(0, 4).toString() !== "%PDF") {
    return {
      ok: false,
      error: "POD document is not a valid PDF",
      proNumber,
      accountNumber,
    };
  }

  return {
    ok: true,
    pdfBuffer,
    proNumber,
    accountNumber,
    keyStatus: track.keyStatus,
    ppodAvailable: track.ppodAvailable,
  };
}

module.exports = {
  isFedExFreightCarrier,
  resolveFedExFreightPro,
  fetchFedExFreightPodPdf,
  trackFedExFreightShipment,
};
