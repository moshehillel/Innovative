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
 * Option B/E confirm page — Primus typeahead + % markup or flat charge.
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
  const bumpRate = !!opts.bumpCustomerRate;
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
  const catalogJson = JSON.stringify(
      Array.isArray(opts.accessorialOptions) ? opts.accessorialOptions : [])
      .replace(/</g, "\\u003c")
      .replace(/-->/g, "--\\u003e");
  const accessorialsUrlJson = JSON.stringify(
      opts.accessorialsUrl ? String(opts.accessorialsUrl) : "");
  const pickHint =
    `Pick each accessorial from the Primus dropdown (type in the filter box ` +
    `above it to narrow the list). ` +
    `Add accessorial for a charge Jerry did not list. Then enter a ` +
    `percent markup (default 30%) or a flat customer amount.`;
  const baseRateHtml = bumpRate ?
    (baseRate > 0 ?
      `<p style="font-size:14px;color:#374151;margin:12px 0">` +
      `<strong>Current customer rate:</strong> $${baseRate.toFixed(2)}. ` +
      `Confirming bumps it by the accessorial total below.</p>` +
      `<p style="font-size:14px;color:#374151;margin:0 0 12px">` +
      `${pickHint}</p>` :
      `<p style="font-size:14px;color:#374151;margin:12px 0">` +
      `${pickHint} The total bumps the customer rate.</p>`) :
    (baseRate > 0 ?
      `<p style="font-size:14px;color:#374151;margin:12px 0">` +
      `<strong>Base customer rate (unchanged):</strong> ` +
      `$${baseRate.toFixed(2)}</p>` +
      `<p style="font-size:14px;color:#374151;margin:0 0 12px">` +
      `${pickHint}</p>` :
      `<p style="font-size:14px;color:#374151;margin:12px 0">` +
      `The base customer freight rate will stay as-is. ${pickHint}</p>`);
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
    `.bill-picker{position:relative;display:flex;flex-direction:column;` +
    `gap:6px}` +
    `.bill-name-search{font-size:14px}` +
    `.bill-name-select{min-height:44px;font-size:15px}` +
    `.bill-menu{display:none;position:absolute;z-index:20;left:0;right:0;` +
    `top:calc(100% + 2px);max-height:220px;overflow:auto;background:#fff;` +
    `border:1px solid #d1d5db;border-radius:8px;` +
    `box-shadow:0 8px 20px rgba(15,23,42,.12)}` +
    `.bill-menu.open{display:block}` +
    `.bill-menu-item{display:block;width:100%;text-align:left;border:0;` +
    `background:#fff;padding:8px 10px;font-size:14px;cursor:pointer}` +
    `.bill-menu-item:hover{background:#f3f4f6}` +
    `.bill-menu-empty{padding:8px 10px;font-size:12px;color:#6b7280}` +
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
    `let catalog = ${catalogJson};` +
    `const accessorialsUrl = ${accessorialsUrlJson};` +
    `const container = document.getElementById("bill-lines");` +
    `function escAttr(v){return String(v ?? "").replace(/&/g,"&amp;")` +
    `.replace(/"/g,"&quot;").replace(/</g,"&lt;");}` +
    `function money(n){return "$"+(Number(n)||0).toFixed(2);}` +
    `function normName(v){return String(v||"").toLowerCase()` +
    `.replace(/[^a-z0-9]/g,"");}` +
    `function filterCatalog(q){` +
    `const list=Array.isArray(catalog)?catalog:[];` +
    `const want=normName(q);` +
    `if(!want)return list.slice(0,50);` +
    `return list.filter((item)=>{` +
    `const name=normName(item.name);` +
    `const code=normName(item.code);` +
    `const cat=normName(item.category);` +
    `return name.includes(want)||code.includes(want)||cat.includes(want)||` +
    `want.includes(name);}).slice(0,50);}` +
    `function filterAll(q){` +
    `const list=Array.isArray(catalog)?catalog:[];` +
    `const want=normName(q);` +
    `if(!want)return list.slice();` +
    `return list.filter((item)=>{` +
    `const name=normName(item.name);` +
    `const code=normName(item.code);` +
    `const cat=normName(item.category);` +
    `return name.includes(want)||code.includes(want)||cat.includes(want)||` +
    `want.includes(name);});}` +
    `function matchCatalog(name,code){` +
    `const want=normName(name);const wantCode=String(code||"");` +
    `const list=Array.isArray(catalog)?catalog:[];` +
    `for(const item of list){` +
    `if((wantCode&&item.code===wantCode)||` +
    `(want&&(normName(item.name)===want||normName(item.code)===want)))` +
    `return item;}` +
    `if(want.length<4)return null;` +
    `const loose=list.filter((item)=>{` +
    `const label=normName(item.name);` +
    `return label.includes(want)||want.includes(label);});` +
    `return loose.length===1?loose[0]:null;}` +
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
    `(row.markupPct!=null?row.markupPct:30);` +
    `const top=document.createElement("div");top.className="bill-row-top";` +
    `const nameCell=document.createElement("div");` +
    `const label=document.createElement("label");` +
    `label.className="field-label";` +
    `label.textContent="Primus accessorial";` +
    `const picker=document.createElement("div");picker.className="bill-picker";` +
    `const search=document.createElement("input");` +
    `search.type="search";search.className="bill-name-search";` +
    `search.autocomplete="off";` +
    `search.placeholder="Filter the dropdown list (optional)";` +
    `const nameHidden=document.createElement("input");` +
    `nameHidden.type="hidden";nameHidden.className="bill-name";` +
    `const codeHidden=document.createElement("input");` +
    `codeHidden.type="hidden";codeHidden.className="bill-code";` +
    `const select=document.createElement("select");` +
    `select.className="bill-name-select";` +
    `select.setAttribute("aria-label","Primus accessorial");` +
    `function setChoice(item){` +
    `nameHidden.value=item&&item.name||"";` +
    `codeHidden.value=item&&item.code||"";}` +
    `function fillSelect(){` +
    `while(select.options.length)select.remove(0);` +
    `const ph=document.createElement("option");ph.value="";` +
    `ph.textContent="— Select Primus accessorial —";select.appendChild(ph);` +
    `const items=filterAll(search.value);let saw=false;` +
    `items.forEach((item)=>{` +
    `const opt=document.createElement("option");` +
    `opt.value=String(item.name||"");opt.dataset.code=item.code||"";` +
    `opt.textContent=(item.category?item.category+" — ":"")+item.name;` +
    `if((codeHidden.value&&item.code===codeHidden.value)||` +
    `(nameHidden.value&&normName(item.name)===normName(nameHidden.value))){` +
    `opt.selected=true;saw=true;}` +
    `select.appendChild(opt);});` +
    `if(!saw){select.value="";` +
    `if(items.length===1&&search.value){` +
    `select.selectedIndex=1;setChoice(items[0]);}}}` +
    `const matched=matchCatalog(row.name,row.code);` +
    `if(matched){setChoice(matched);` +
    `}else if(row.name){` +
    `if(filterAll(row.name).length)search.value=String(row.name);` +
    `search.placeholder="Filter — Jerry listed: "+row.name;}` +
    `fillSelect();` +
    `search.oninput=()=>fillSelect();` +
    `select.onchange=()=>{` +
    `const opt=select.options[select.selectedIndex];` +
    `if(!opt||!opt.value){setChoice(null);return;}` +
    `setChoice({name:opt.value,code:opt.dataset.code||""});};` +
    `picker.appendChild(search);picker.appendChild(select);` +
    `picker.appendChild(nameHidden);picker.appendChild(codeHidden);` +
    `nameCell.appendChild(label);nameCell.appendChild(picker);` +
    `const remove=document.createElement("button");` +
    `remove.type="button";remove.className="remove-btn";` +
    `remove.title="Remove";remove.textContent="×";` +
    `remove.onclick=()=>{wrap.remove();};` +
    `top.appendChild(nameCell);top.appendChild(remove);` +
    `const meta=document.createElement("p");meta.className="bill-meta";` +
    `meta.innerHTML="<strong>Carrier cost:</strong> "+` +
    `(carrier>0?money(carrier):"Not set — use flat charge or edit");` +
    `const price=document.createElement("div");price.className="bill-price";` +
    `price.innerHTML="<div><label class=\\"field-label\\">Charge type</label>"+` +
    `"<select class=\\"bill-mode\\"><option value=\\"markup\\""+` +
    `(mode==="markup"?" selected":"")+` +
    `">Percent markup</option><option value=\\"flat\\""+` +
    `(mode==="flat"?" selected":"")+` +
    `">Flat customer amount</option></select></div><div>"+` +
    `"<label class=\\"field-label bill-value-label\\">"+` +
    `(mode==="flat"?"Flat amount ($)":"Markup (%)")+"</label>"+` +
    `"<input type=\\"number\\" class=\\"bill-value\\" min=\\"0\\" ` +
    `step=\\"0.01\\" placeholder=\\""+(mode==="flat"?"250.00":"30")+` +
    `"\\" value=\\""+escAttr(seedVal===0||seedVal?String(seedVal):"")+` +
    `"\\" required></div>";` +
    `const preview=document.createElement("div");` +
    `preview.className="bill-preview";` +
    `wrap.appendChild(top);wrap.appendChild(meta);` +
    `wrap.appendChild(price);wrap.appendChild(preview);` +
    `const syncLabel=()=>{` +
    `const m=wrap.querySelector(".bill-mode").value;` +
    `wrap.querySelector(".bill-value-label").textContent=` +
    `m==="flat"?"Flat amount ($)":"Markup (%)";` +
    `wrap.querySelector(".bill-value").placeholder=` +
    `m==="flat"?"250.00":"30";refreshPreview(wrap);};` +
    `wrap.querySelector(".bill-mode").onchange=syncLabel;` +
    `wrap.querySelector(".bill-value").oninput=()=>refreshPreview(wrap);` +
    `container.appendChild(wrap);refreshPreview(wrap);}` +
    `function renderSeedRows(){` +
    `container.innerHTML="";` +
    `(seedRows.length?seedRows:[{name:"",carrierAmount:0}]).forEach(addRow);}` +
    `renderSeedRows();` +
    `document.getElementById("add-bill-line").onclick=` +
    `()=>addRow({name:"",carrierAmount:0});` +
    `if(accessorialsUrl){` +
    `fetch(accessorialsUrl,{credentials:"omit"}).then((r)=>r.json())` +
    `.then((data)=>{` +
    `if(!data||!Array.isArray(data.accessorials)||!data.accessorials.length)` +
    `return;` +
    `catalog=data.accessorials;` +
    `const hadRows=container.querySelectorAll(".bill-row").length;` +
    `if(hadRows){` +
    `const existing=[];` +
    `container.querySelectorAll(".bill-row").forEach((row)=>{` +
    `existing.push({` +
    `name:row.querySelector(".bill-name").value||` +
    `row.querySelector(".bill-name-search").value||"",` +
    `code:row.querySelector(".bill-code").value||"",` +
    `carrierAmount:Number(row.dataset.carrierAmount)||0,` +
    `pricingMode:row.querySelector(".bill-mode").value,` +
    `markupPct:row.querySelector(".bill-mode").value==="markup"?` +
    `row.querySelector(".bill-value").value:null,` +
    `flatAmount:row.querySelector(".bill-mode").value==="flat"?` +
    `row.querySelector(".bill-value").value:null});});` +
    `container.innerHTML="";` +
    `existing.forEach(addRow);}` +
    `}).catch(()=>{});}` +
    `document.getElementById("option-b-form").onsubmit=(e)=>{` +
    `const lines=[];` +
    `for(const row of container.querySelectorAll(".bill-row")){` +
    `let name=(row.querySelector(".bill-name").value||"").trim();` +
    `let code=row.querySelector(".bill-code").value||"";` +
    `const typed=(row.querySelector(".bill-name-search").value||"").trim();` +
    `if(!name&&typed){` +
    `const auto=matchCatalog(typed,code);` +
    `if(auto){name=auto.name||typed;code=auto.code||code;` +
    `row.querySelector(".bill-name").value=name;` +
    `row.querySelector(".bill-code").value=code;` +
    `row.querySelector(".bill-name-search").value=name;}}` +
    `if(!name){` +
    `if(typed){alert("Select \\""+typed+"\\" from the Primus dropdown "+` +
    `"(the filter box narrows the list).");e.preventDefault();return false;}` +
    `continue;}` +
    `const carrierAmount=Number(row.dataset.carrierAmount)||0;` +
    `const mode=row.querySelector(".bill-mode").value;` +
    `const val=Number(row.querySelector(".bill-value").value);` +
    `if(mode==="flat"){` +
    `if(!(val>0)){alert("Enter a flat customer charge for "+name);` +
    `e.preventDefault();return false;}` +
    `lines.push({name,code,carrierAmount,pricingMode:"flat",flatAmount:val,` +
    `markupPct:null,amount:val});` +
    `}else{` +
    `if(!(carrierAmount>0)){alert(name+": carrier cost required for ` +
    `% markup, or switch to flat amount.");e.preventDefault();return false;}` +
    `if(!Number.isFinite(val)||val<0){alert("Enter a markup % for "+name);` +
    `e.preventDefault();return false;}` +
    `const amount=Math.round(carrierAmount*(1+val/100)*100)/100;` +
    `lines.push({name,code,carrierAmount,pricingMode:"markup",markupPct:val,` +
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

/**
 * Option F confirm page — flat amount or percent of the carrier invoice.
 * The result replaces the customer rate and is billed as accessorial Freight.
 * @param {object} opts Form options.
 * @return {string}
 */
function buildOptionFConfirmPage(opts) {
  const fields = opts.fields || {};
  const btnColor = opts.confirmColor || "#c2410c";
  const formAction = `${functionsBaseUrl()}/${opts.actionPath}`;
  const esc = escapeHtml;
  const hidden = Object.entries(fields)
      .map(([name, value]) =>
        `<input type="hidden" name="${esc(name)}" ` +
        `value="${esc(String(value ?? ""))}">`)
      .join("");
  const invoiceAmount = Number(opts.invoiceAmount) || 0;
  const invoiceLabel = invoiceAmount > 0 ?
    `$${invoiceAmount.toFixed(2)}` : "unavailable";
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(opts.title || "Confirm option F")}</title>` +
    `<style>` +
    `input[type=number],select{width:100%;padding:10px 12px;` +
    `border:1px solid #d1d5db;border-radius:8px;font-size:16px;` +
    `box-sizing:border-box;background:#fff}` +
    `.field-label{font-size:12px;color:#6b7280;margin:0 0 4px;display:block}` +
    `.mode{display:flex;gap:16px;margin:8px 0 14px;font-size:15px}` +
    `.preview{font-size:15px;color:#9a3412;font-weight:600;margin:12px 0}` +
    `@keyframes spin{to{transform:rotate(360deg)}}` +
    `</style></head>` +
    `<body style="font-family:Arial,sans-serif;max-width:640px;` +
    `margin:48px auto;padding:0 16px;color:#111827">` +
    `<h1 style="font-size:22px;margin-bottom:12px">` +
    `${esc(opts.title || "Confirm option F")}</h1>` +
    `<p style="font-size:16px;color:#374151;line-height:1.5">` +
    `${opts.description || ""}</p>` +
    `<p style="font-size:14px;color:#374151;margin:12px 0">` +
    `<strong>Carrier invoice total:</strong> ${esc(invoiceLabel)}</p>` +
    `<form method="POST" action="${esc(formAction)}" id="option-f-form" ` +
    `style="margin-top:16px">` +
    hidden +
    `<span class="field-label">How to set the customer rate</span>` +
    `<div class="mode">` +
    `<label><input type="radio" name="rateMode" value="flat" checked> ` +
    `Flat amount ($)</label>` +
    `<label><input type="radio" name="rateMode" value="percent"` +
    (invoiceAmount > 0 ? "" : " disabled") +
    `> Percent of invoice (%)</label>` +
    `</div>` +
    `<label class="field-label" for="rateInput" id="rate-input-label">` +
    `Flat amount ($)</label>` +
    `<input id="rateInput" name="rateInput" type="number" required ` +
    `min="0.01" step="0.01" placeholder="0.00">` +
    `<p class="preview" id="rate-preview"></p>` +
    `<p style="font-size:13px;color:#6b7280">This amount replaces the ` +
    `customer rate and is entered in Primus as an accessorial named ` +
    `<strong>Freight</strong>. Nothing is sent until you click Confirm.</p>` +
    `<button type="submit" style="margin-top:16px;background:${btnColor};` +
    `color:#fff;border:0;padding:12px 18px;border-radius:8px;` +
    `font-size:16px;font-weight:600;cursor:pointer">` +
    `${esc(opts.confirmLabel || "Confirm option F")}</button>` +
    `</form>` +
    `<script>` +
    `(function(){` +
    `var invoice=${invoiceAmount > 0 ? invoiceAmount.toFixed(2) : "0"};` +
    `var form=document.getElementById("option-f-form");` +
    `var input=document.getElementById("rateInput");` +
    `var label=document.getElementById("rate-input-label");` +
    `var preview=document.getElementById("rate-preview");` +
    `function mode(){` +
    `var picked=form.querySelector('input[name="rateMode"]:checked');` +
    `return picked?picked.value:"flat";}` +
    `function refresh(){` +
    `var pct=mode()==="percent";` +
    `label.textContent=pct?"Percent of invoice (%)":"Flat amount ($)";` +
    `input.placeholder=pct?"0.00":"0.00";` +
    `input.step=pct?"0.01":"0.01";` +
    `var n=Number(input.value);` +
    `var amount=0;` +
    `if(Number.isFinite(n)&&n>0){` +
    `amount=pct?Math.round(invoice*(n/100)*100)/100:Math.round(n*100)/100;}` +
    `preview.textContent=amount>0?` +
    `("Customer rate entered in Primus as Freight: $"+amount.toFixed(2)):"";` +
    `}` +
    `form.addEventListener("change",refresh);` +
    `input.addEventListener("input",refresh);` +
    `form.addEventListener("submit",function(e){` +
    `var n=Number(input.value);` +
    `if(!Number.isFinite(n)||n<=0){` +
    `alert(mode()==="percent"?` +
    `"Enter a percent greater than 0.":"Enter a flat amount greater than 0.");` +
    `e.preventDefault();return false;}` +
    `if(mode()==="percent"&&(!(invoice>0)||n>500)){` +
    `alert(invoice>0?"Percent must be 500 or less.":` +
    `"Invoice total is missing. Use a flat amount.");` +
    `e.preventDefault();return false;}` +
    `var btn=form.querySelector('button[type="submit"]');` +
    `if(btn&&!btn.disabled){btn.disabled=true;` +
    `btn.textContent="Processing...";}` +
    `return true;});` +
    `refresh();` +
    `})();` +
    `</script></body></html>`;
}

module.exports = {
  escapeHtml,
  functionsBaseUrl,
  buildEmailActionConfirmPage,
  buildEmailActionProcessingPage,
  buildOptionBAccessorialConfirmPage,
  buildOptionFConfirmPage,
  simpleResultPage,
};
