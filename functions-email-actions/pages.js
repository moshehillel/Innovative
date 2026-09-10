/**
 * Confirmation / processing HTML for email action links.
 */
"use strict";

const emailActionTokens = require("./email-action-tokens");

/**
 * @param {*} str Value.
 * @return {string}
 */
function escapeHtml(str) {
  return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
}

/**
 * @return {string}
 */
function functionsBaseUrl() {
  return emailActionTokens.publicFunctionsBaseUrl();
}

/**
 * @param {object} opts Page options.
 * @return {string}
 */
function buildEmailActionConfirmPage(opts) {
  const fields = opts.fields || {};
  const btnColor = opts.confirmColor || "#2563eb";
  const formAction = `${functionsBaseUrl()}/${opts.actionPath}`;
  const hidden = Object.entries(fields)
      .map(([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" ` +
        `value="${escapeHtml(String(value ?? ""))}">`)
      .join("");
  const inputFields = Array.isArray(opts.inputFields) ? opts.inputFields : [];
  const inputs = inputFields.map((field) => {
    const attrs = [
      `type="${escapeHtml(field.type || "text")}"`,
      `name="${escapeHtml(field.name)}"`,
      `id="${escapeHtml(field.name)}"`,
      field.value != null && field.value !== "" ?
        `value="${escapeHtml(String(field.value))}"` : "",
      field.required ? "required" : "",
      field.min != null ? `min="${escapeHtml(String(field.min))}"` : "",
      field.step != null ? `step="${escapeHtml(String(field.step))}"` : "",
      field.placeholder ?
        `placeholder="${escapeHtml(field.placeholder)}"` : "",
    ].filter(Boolean).join(" ");
    return `<label for="${escapeHtml(field.name)}" ` +
      `style="display:block;font-size:14px;font-weight:600;` +
      `color:#374151;margin-bottom:6px">` +
      `${escapeHtml(field.label || field.name)}</label>` +
      `<input ${attrs} style="width:100%;max-width:240px;padding:10px 12px;` +
      `border:1px solid #d1d5db;border-radius:8px;font-size:16px;` +
      `margin-bottom:16px">`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(opts.title || "Confirm")}</title>` +
    `<style>@keyframes spin{to{transform:rotate(360deg)}}</style></head>` +
    `<body style="font-family:Arial,sans-serif;max-width:520px;` +
    `margin:48px auto;padding:0 16px;color:#111827">` +
    `<h1 style="font-size:22px;margin-bottom:12px">` +
    `${escapeHtml(opts.title || "Confirm action")}</h1>` +
    `<p style="font-size:16px;color:#374151;line-height:1.5">` +
    `${opts.description || ""}</p>` +
    `<form method="POST" action="${escapeHtml(formAction)}" ` +
    `style="margin-top:24px">` +
    hidden +
    inputs +
    `<button type="submit" style="background:${btnColor};` +
    `color:#fff;border:none;padding:12px 20px;border-radius:8px;` +
    `font-size:16px;font-weight:600;cursor:pointer">` +
    `${escapeHtml(opts.confirmLabel || "Confirm")}</button>` +
    `</form>` +
    `<p style="font-size:13px;color:#9ca3af;margin-top:20px">` +
    `If you did not request this, close this page - nothing has been ` +
    `changed yet.</p>` +
    `<script>` +
    `document.querySelector("form")?.addEventListener("submit",(e)=>{` +
    `const btn=e.target.querySelector('button[type="submit"]');` +
    `if(!btn||btn.disabled)return;btn.disabled=true;` +
    `btn.innerHTML='<span style="display:inline-block;width:16px;height:16px;` +
    `border:2px solid rgba(255,255,255,.35);border-top-color:#fff;` +
    `border-radius:50%;animation:spin .7s linear infinite;` +
    `vertical-align:-3px;margin-right:8px"></span>Processing…';` +
    `});` +
    `</script></body></html>`;
}

/**
 * @param {object} opts Page options.
 * @return {string}
 */
function buildEmailActionProcessingPage(opts) {
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(opts.title || "Processing")}</title>` +
    `<style>@keyframes spin{to{transform:rotate(360deg)}}</style>` +
    `</head><body style="font-family:Arial,sans-serif;text-align:center;` +
    `padding:48px;color:#111827">` +
    `<div style="width:40px;height:40px;border:3px solid #e5e7eb;` +
    `border-top-color:#2563eb;border-radius:50%;animation:spin .8s linear ` +
    `infinite;margin:0 auto 20px"></div>` +
    `<h1 style="font-size:22px;margin-bottom:12px;color:#111827">` +
    `${escapeHtml(opts.title || "Processing your decision")}</h1>` +
    `<p style="font-size:16px;color:#374151;line-height:1.5;max-width:420px;` +
    `margin:0 auto">` +
    `${opts.message || "Jerry is updating billing now. You can close this " +
    "page — we will email if anything needs follow-up."}</p>` +
    (opts.loadNumber ?
      `<p style="font-size:13px;color:#9ca3af;margin-top:20px">Load ` +
      `${escapeHtml(String(opts.loadNumber))}</p>` : "") +
    `</body></html>`;
}

/**
 * Option B confirm page — itemized customer accessorial billing.
 * @param {object} opts Form options.
 * @return {string}
 */
function buildOptionBAccessorialConfirmPage(opts) {
  const fields = opts.fields || {};
  const btnColor = opts.confirmColor || "#0d9488";
  const formAction = `${opts.baseUrl}/${opts.actionPath}`;
  const esc = escapeHtml;
  const hidden = Object.entries(fields)
      .map(([name, value]) =>
        `<input type="hidden" name="${esc(name)}" ` +
        `value="${esc(String(value ?? ""))}">`)
      .join("");
  const baseRate = Number(opts.baseCustomerRate) || 0;
  const charges = Array.isArray(opts.carrierCharges) ? opts.carrierCharges : [];
  const seedRows = charges.map((charge) => ({
    name: String((charge && (charge.label || charge.name || charge.type)) ||
      "Accessorial"),
    amount: "",
    carrierAmount: Number(charge && charge.amount) || 0,
  }));
  if (!seedRows.length) seedRows.push({name: "", amount: "", carrierAmount: 0});
  const seedJson = JSON.stringify(seedRows)
      .replace(/</g, "\\u003c")
      .replace(/-->/g, "--\\u003e");
  const baseRateHtml = baseRate > 0 ?
    `<p style="font-size:14px;color:#374151;margin:12px 0">` +
    `<strong>Base customer rate (unchanged):</strong> ` +
    `$${baseRate.toFixed(2)}</p>` :
    `<p style="font-size:14px;color:#374151;margin:12px 0">` +
    `The base customer freight rate will stay as-is. Enter each ` +
    `accessorial and the amount to bill the customer below.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(opts.title || "Confirm option B")}</title>` +
    `<style>` +
    `.bill-row{display:grid;grid-template-columns:1fr 140px 32px;gap:8px;` +
    `align-items:start;margin-bottom:10px}` +
    `.bill-row input{width:100%;padding:10px 12px;border:1px solid #d1d5db;` +
    `border-radius:8px;font-size:16px;box-sizing:border-box}` +
    `.bill-hint{font-size:12px;color:#6b7280;margin-top:4px}` +
    `.add-btn{background:#fff;color:#0d9488;border:1px solid #0d9488;` +
    `padding:8px 12px;border-radius:8px;font-size:14px;cursor:pointer}` +
    `.remove-btn{background:#fff;color:#dc2626;border:1px solid #fecaca;` +
    `border-radius:8px;width:32px;height:42px;cursor:pointer}` +
    `@keyframes spin{to{transform:rotate(360deg)}}` +
    `</style></head>` +
    `<body style="font-family:Arial,sans-serif;max-width:560px;` +
    `margin:48px auto;padding:0 16px;color:#111827">` +
    `<h1 style="font-size:22px;margin-bottom:12px">` +
    `${esc(opts.title || "Confirm option B")}</h1>` +
    `<p style="font-size:16px;color:#374151;line-height:1.5">` +
    `${opts.description || ""}</p>` +
    baseRateHtml +
    `<form method="POST" action="${esc(formAction)}" id="option-b-form" ` +
    `style="margin-top:16px">` +
    hidden +
    `<input type="hidden" name="customerBillLinesJson" ` +
    `id="customerBillLinesJson">` +
    `<p style="font-size:14px;font-weight:600;color:#374151;` +
    `margin-bottom:8px">Accessorials to bill the customer</p>` +
    `<div id="bill-lines"></div>` +
    `<button type="button" class="add-btn" id="add-bill-line">` +
    `+ Add accessorial</button>` +
    `<div style="margin-top:20px">` +
    `<button type="submit" style="background:${btnColor};color:#fff;` +
    `border:none;padding:12px 20px;border-radius:8px;font-size:16px;` +
    `font-weight:600;cursor:pointer">` +
    `${esc(opts.confirmLabel || "Confirm option B")}</button>` +
    `</div></form>` +
    `<p style="font-size:13px;color:#9ca3af;margin-top:20px">` +
    `If you did not request this, close this page - nothing has been ` +
    `changed yet.</p>` +
    `<script>` +
    `const seedRows = ${seedJson};` +
    `const container = document.getElementById("bill-lines");` +
    `function escAttr(v){return String(v ?? "").replace(/&/g,"&amp;")` +
    `.replace(/"/g,"&quot;").replace(/</g,"&lt;");}` +
    `function addRow(row={}){` +
    `const wrap=document.createElement("div");wrap.className="bill-row";` +
    `const hint=row.carrierAmount?` +
    `"<div class=\\"bill-hint\\">Carrier billed ` +
    `"+row.carrierAmount.toFixed(2)+"</div>":"";` +
    `wrap.innerHTML="<div><input type=\\"text\\" class=\\"bill-name\\" ` +
    `placeholder=\\"Accessorial name\\" value=\\""+escAttr(row.name||"")+` +
    `"\\" required>"+hint+"</div><div><input type=\\"number\\" ` +
    `class=\\"bill-amount\\" min=\\"0.01\\" step=\\"0.01\\" ` +
    `placeholder=\\"0.00\\" value=\\""+escAttr(row.amount||"")+` +
    `"\\" required></div><button type=\\"button\\" class=\\"remove-btn\\" ` +
    `title=\\"Remove\\">×</button>";` +
    `wrap.querySelector(".remove-btn").onclick=()=>{wrap.remove();};` +
    `container.appendChild(wrap);}` +
    `(seedRows.length?seedRows:[{name:"",amount:""}]).forEach(addRow);` +
    `document.getElementById("add-bill-line").onclick=()=>addRow({});` +
    `document.getElementById("option-b-form").onsubmit=(e)=>{` +
    `const lines=[...container.querySelectorAll(".bill-row")].map((row)=>{` +
    `return {name:row.querySelector(".bill-name").value.trim(),` +
    `amount:Number(row.querySelector(".bill-amount").value)};` +
    `}).filter((line)=>line.name&&line.amount>0);` +
    `if(!lines.length){alert("Enter at least one accessorial and amount.");` +
    `e.preventDefault();return false;}` +
    `document.getElementById("customerBillLinesJson").value=` +
    `JSON.stringify(lines);` +
    `const btn=e.target.querySelector('button[type="submit"]');` +
    `if(btn){btn.disabled=true;btn.textContent="Processing…";}` +
    `};` +
    `</script></body></html>`;
}

/**
 * @param {string} title Title.
 * @param {string} color Heading color.
 * @param {string} message Body.
 * @param {string} [loadNumber] Optional load.
 * @return {string}
 */
function simpleResultPage(title, color, message, loadNumber) {
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title></head>` +
    `<body style="font-family:Arial,sans-serif;text-align:center;` +
    `padding:48px;color:#111827">` +
    `<h1 style="color:${color};margin-bottom:12px">` +
    `${escapeHtml(title)}</h1>` +
    `<p style="font-size:16px;color:#374151;max-width:520px;` +
    `margin:0 auto 16px;line-height:1.5">${message}</p>` +
    (loadNumber ?
      `<p style="font-size:13px;color:#9ca3af">Load ` +
      `${escapeHtml(String(loadNumber))}</p>` : "") +
    `</body></html>`;
}

module.exports = {
  escapeHtml,
  functionsBaseUrl,
  buildEmailActionConfirmPage,
  buildEmailActionProcessingPage,
  buildOptionBAccessorialConfirmPage,
  simpleResultPage,
};
