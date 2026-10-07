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
  const done = opts.done === true;
  const pollUrl = opts.pollUrl ? String(opts.pollUrl) : "";
  const spinner = done ? "" :
    `<div id="spin" style="width:40px;height:40px;border:3px solid #e5e7eb;` +
    `border-top-color:#2563eb;border-radius:50%;animation:spin .8s linear ` +
    `infinite;margin:0 auto 20px"></div>`;
  const check = done ?
    `<div style="width:48px;height:48px;border-radius:50%;background:#059669;` +
    `color:#fff;font-size:28px;line-height:48px;margin:0 auto 20px">✓</div>` :
    "";
  const pollScript = (!done && pollUrl) ? `<script>
(function(){
  var url=${JSON.stringify(pollUrl)};
  var tries=0;
  function tick(){
    tries++;
    fetch(url,{credentials:"omit"}).then(function(r){return r.json();})
      .then(function(j){
        if(!j||!j.status) return;
        var spin=document.getElementById("spin");
        var title=document.getElementById("title");
        var msg=document.getElementById("msg");
        if(j.status==="completed"||j.status==="reprocessed"||j.already){
          if(spin) spin.style.display="none";
          if(title) title.textContent="Done";
          if(msg) msg.textContent=j.message||
            ("Load "+(j.loadNumber||"")+" is processing. You can close this page.");
          return;
        }
        if(j.status==="failed"){
          if(spin) spin.style.display="none";
          if(title) title.textContent="Could not finish";
          if(msg) msg.textContent=j.error||
            "Jerry could not reprocess this invoice. Check your email for details.";
          return;
        }
        if(tries<90) setTimeout(tick, 2000);
        else if(msg) msg.textContent=
          "Still working in the background — you can close this page. Jerry will email if anything needs attention.";
      }).catch(function(){ if(tries<90) setTimeout(tick, 3000); });
  }
  setTimeout(tick, 2500);
})();
</script>` : "";
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(opts.title || "Processing")}</title>` +
    `<style>@keyframes spin{to{transform:rotate(360deg)}}</style>` +
    `</head><body style="font-family:Arial,sans-serif;text-align:center;` +
    `padding:48px;color:#111827">` +
    check + spinner +
    `<h1 id="title" style="font-size:22px;margin-bottom:12px;color:#111827">` +
    `${escapeHtml(opts.title || "Processing your decision")}</h1>` +
    `<p id="msg" style="font-size:16px;color:#374151;line-height:1.5;` +
    `max-width:420px;margin:0 auto">` +
    `${opts.message || "Jerry is updating billing now. You can close this " +
    "page — we will email if anything needs follow-up."}</p>` +
    (opts.loadNumber ?
      `<p style="font-size:13px;color:#9ca3af;margin-top:20px">Load ` +
      `${escapeHtml(String(opts.loadNumber))}</p>` : "") +
    pollScript +
    `</body></html>`;
}

/**
 * Option B confirm page — accessorials with % markup or flat customer charge.
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
  if (!seedRows.length) {
    seedRows.push({name: "", amount: "", carrierAmount: 0});
  }
  const seedJson = JSON.stringify(seedRows)
      .replace(/</g, "\\u003c")
      .replace(/-->/g, "--\\u003e");
  const baseRateHtml = baseRate > 0 ?
    `<p style="font-size:14px;color:#374151;margin:12px 0">` +
    `<strong>Base customer rate (unchanged):</strong> ` +
    `$${baseRate.toFixed(2)}</p>` :
    `<p style="font-size:14px;color:#374151;margin:12px 0">` +
    `The base customer freight rate will stay as-is. For each ` +
    `accessorial, enter a percent markup or a flat customer charge.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(opts.title || "Confirm option B")}</title>` +
    `<style>` +
    `.bill-row{border:1px solid #e5e7eb;border-radius:10px;padding:12px;` +
    `margin-bottom:12px;background:#fafafa}` +
    `.bill-row-top{display:grid;grid-template-columns:1fr 32px;gap:8px;` +
    `align-items:start;margin-bottom:8px}` +
    `.bill-row input,.bill-row select{width:100%;padding:10px 12px;` +
    `border:1px solid #d1d5db;border-radius:8px;font-size:16px;` +
    `box-sizing:border-box;background:#fff}` +
    `.bill-meta{font-size:13px;color:#374151;margin:0 0 8px}` +
    `.bill-meta strong{color:#111827}` +
    `.bill-price{display:grid;grid-template-columns:140px 1fr;gap:8px;` +
    `align-items:end}` +
    `.bill-preview{font-size:13px;color:#0f766e;margin-top:8px;` +
    `font-weight:600}` +
    `.field-label{font-size:12px;color:#6b7280;margin:0 0 4px;` +
    `display:block}` +
    `.add-btn{background:#fff;color:#0d9488;border:1px solid #0d9488;` +
    `padding:8px 12px;border-radius:8px;font-size:14px;cursor:pointer}` +
    `.remove-btn{background:#fff;color:#dc2626;border:1px solid #fecaca;` +
    `border-radius:8px;width:32px;height:42px;cursor:pointer}` +
    `@keyframes spin{to{transform:rotate(360deg)}}` +
    `</style></head>` +
    `<body style="font-family:Arial,sans-serif;max-width:640px;` +
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
    `margin-bottom:8px">Additional accessorials</p>` +
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
    `function money(n){return "$"+(Number(n)||0).toFixed(2);}` +
    `function refreshPreview(wrap){` +
    `const carrier=Number(wrap.dataset.carrierAmount)||0;` +
    `const mode=wrap.querySelector(".bill-mode").value;` +
    `const val=Number(wrap.querySelector(".bill-value").value);` +
    `const el=wrap.querySelector(".bill-preview");` +
    `if(mode==="flat"){el.textContent=Number.isFinite(val)&&val>0?` +
    `"Customer charged: "+money(val):"Enter a flat customer charge";` +
    `return;}` +
    `if(!(carrier>0)){el.textContent=` +
    `"Carrier cost required for percent markup";return;}` +
    `if(!Number.isFinite(val)||val<0){el.textContent=` +
    `"Enter a markup percent";return;}` +
    `const amt=Math.round(carrier*(1+val/100)*100)/100;` +
    `el.textContent="Customer charged: "+money(amt)+` +
    `" ("+money(carrier)+" + "+val+"%)";}` +
    `function addRow(row={}){` +
    `const wrap=document.createElement("div");wrap.className="bill-row";` +
    `const carrier=Number(row.carrierAmount)||0;` +
    `wrap.dataset.carrierAmount=String(carrier);` +
    `const mode=row.pricingMode==="flat"?"flat":"markup";` +
    `const seedVal=mode==="flat"?` +
    `(row.flatAmount!=null?row.flatAmount:row.amount||""):` +
    `(row.markupPct!=null?row.markupPct:"");` +
    `wrap.innerHTML="<div class=\\"bill-row-top\\"><div>"+` +
    `"<label class=\\"field-label\\">Accessorial name</label>"+` +
    `"<input type=\\"text\\" class=\\"bill-name\\" ` +
    `placeholder=\\"e.g. Liftgate\\" value=\\""+escAttr(row.name||"")+` +
    `"\\" required></div>"+` +
    `"<button type=\\"button\\" class=\\"remove-btn\\" ` +
    `title=\\"Remove\\">×</button></div>"+` +
    `"<p class=\\"bill-meta\\"><strong>Carrier cost:</strong> "+` +
    `(carrier>0?money(carrier):"Not set — use flat charge or edit")+` +
    `"</p>"+` +
    `"<div class=\\"bill-price\\"><div>"+` +
    `"<label class=\\"field-label\\">Charge type</label>"+` +
    `"<select class=\\"bill-mode\\"><option value=\\"markup\\""+` +
    `(mode==="markup"?" selected":"")+` +
    `">Percent markup</option><option value=\\"flat\\""+` +
    `(mode==="flat"?" selected":"")+` +
    `">Flat customer amount</option></select></div><div>"+` +
    `"<label class=\\"field-label bill-value-label\\">"+` +
    `(mode==="flat"?"Flat amount ($)":"Markup (%)")+"</label>"+` +
    `"<input type=\\"number\\" class=\\"bill-value\\" min=\\"0\\" ` +
    `step=\\"0.01\\" placeholder=\\""+(mode==="flat"?"250.00":"20")+` +
    `"\\" value=\\""+escAttr(seedVal===0||seedVal?String(seedVal):"")+` +
    `"\\" required></div></div>"+` +
    `"<div class=\\"bill-preview\\"></div>";` +
    `const syncLabel=()=>{` +
    `const m=wrap.querySelector(".bill-mode").value;` +
    `wrap.querySelector(".bill-value-label").textContent=` +
    `m==="flat"?"Flat amount ($)":"Markup (%)";` +
    `wrap.querySelector(".bill-value").placeholder=` +
    `m==="flat"?"250.00":"20";refreshPreview(wrap);};` +
    `wrap.querySelector(".bill-mode").onchange=syncLabel;` +
    `wrap.querySelector(".bill-value").oninput=()=>refreshPreview(wrap);` +
    `wrap.querySelector(".remove-btn").onclick=()=>{wrap.remove();};` +
    `container.appendChild(wrap);refreshPreview(wrap);}` +
    `(seedRows.length?seedRows:[{name:"",carrierAmount:0}]).forEach(addRow);` +
    `document.getElementById("add-bill-line").onclick=` +
    `()=>addRow({name:"",carrierAmount:0});` +
    `document.getElementById("option-b-form").onsubmit=(e)=>{` +
    `const lines=[];` +
    `for(const row of container.querySelectorAll(".bill-row")){` +
    `const name=row.querySelector(".bill-name").value.trim();` +
    `if(!name)continue;` +
    `const carrierAmount=Number(row.dataset.carrierAmount)||0;` +
    `const mode=row.querySelector(".bill-mode").value;` +
    `const val=Number(row.querySelector(".bill-value").value);` +
    `if(mode==="flat"){` +
    `if(!(val>0)){alert("Enter a flat customer charge for "+name);` +
    `e.preventDefault();return false;}` +
    `lines.push({name,carrierAmount,pricingMode:"flat",flatAmount:val,` +
    `markupPct:null,amount:val});` +
    `}else{` +
    `if(!(carrierAmount>0)){alert(name+": carrier cost required for ` +
    `% markup, or switch to flat amount.");e.preventDefault();return false;}` +
    `if(!Number.isFinite(val)||val<0){alert("Enter a markup % for "+name);` +
    `e.preventDefault();return false;}` +
    `const amount=Math.round(carrierAmount*(1+val/100)*100)/100;` +
    `lines.push({name,carrierAmount,pricingMode:"markup",markupPct:val,` +
    `flatAmount:null,amount});}}` +
    `if(!lines.length){alert("Enter at least one accessorial with a ` +
    `percent markup or flat charge.");e.preventDefault();return false;}` +
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
