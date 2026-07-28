#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const {execFileSync} = require("child_process");

const deliverablesDir = __dirname;
const htmlPath = path.join(deliverablesDir, "jerry-program-guide.html");
const logoPath = path.join(deliverablesDir, "aa-logo.png");
const pdfPath = path.join(
    deliverablesDir,
    "Advanced-Automations-Innovative-Carriers-Program-Guide.pdf",
);

let html = fs.readFileSync(htmlPath, "utf8");
if (!fs.existsSync(logoPath)) {
  throw new Error(`Logo not found: ${logoPath}`);
}
const logoB64 = fs.readFileSync(logoPath).toString("base64");
html = html.replace(/__AA_LOGO_BASE64__/g, logoB64);

const footerTemplate = [
  "<div style=\"width:100%;box-sizing:border-box;",
  "padding:6px 48px 0;font-size:8px;font-family:'Segoe UI',Arial,sans-serif;",
  "display:flex;align-items:center;justify-content:space-between;",
  "border-top:2px solid #153a9e;background:linear-gradient(90deg,#08111f,#0f2340 55%,#153a9e);",
  "color:rgba(255,255,255,0.85);height:36px;\">",
  "<img src=\"data:image/png;base64," + logoB64 + "\" ",
  "style=\"height:20px;width:auto;display:block;\" alt=\"AA\"/>",
  "<span style=\"letter-spacing:0.06em;text-transform:uppercase;",
  "font-size:7px;opacity:0.9;\">",
  "Jerry Program Guide &middot; Innovative Carriers</span>",
  "<span style=\"color:#42d392;font-weight:600;font-size:8px;\">",
  "AdvancedAutomations.net &middot; Page <span class=\"pageNumber\"></span>",
  " of <span class=\"totalPages\"></span></span>",
  "</div>",
].join("");

const script = `
const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setContent(${JSON.stringify(html)}, {waitUntil: 'networkidle0'});
  await page.pdf({
    path: ${JSON.stringify(pdfPath)},
    format: 'Letter',
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: ${JSON.stringify(footerTemplate)},
    margin: {
      top: '0.55in',
      right: '0.65in',
      bottom: '0.72in',
      left: '0.65in',
    },
  });
  await browser.close();
})();
`;

const tmpDir = path.join(deliverablesDir, ".pdf-build");
fs.mkdirSync(tmpDir, {recursive: true});
const tmpScript = path.join(tmpDir, "render.cjs");
fs.writeFileSync(tmpScript, script);

console.log("Rendering PDF...");
execFileSync("node", [tmpScript], {
  stdio: "inherit",
  env: {...process.env, NODE_PATH: path.join(tmpDir, "node_modules")},
  cwd: tmpDir,
});

const stats = fs.statSync(pdfPath);
console.log(`Done: ${pdfPath} (${stats.size} bytes)`);
