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
html = html.replace("__AA_LOGO_BASE64__", logoB64);

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
    margin: {top: '0', right: '0', bottom: '0', left: '0'},
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
