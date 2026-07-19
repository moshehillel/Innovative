#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const envFile = path.join(__dirname, "..", ".env.tai-invoice-automation");
for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 1) continue;
  const k = t.slice(0, eq).trim();
  let v = t.slice(eq + 1).trim();
  if (
    (v.startsWith("\"") && v.endsWith("\"")) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  if (!process.env[k]) process.env[k] = v;
}

async function main() {
  const bridge = require("../primus-ui-bridge");
  if (typeof bridge.init === "function") {
    bridge.init({
      writeLog: async () => {},
      firestore: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => ({exists: false, data: () => null}),
            set: async () => {},
          }),
        }),
      }),
    });
  }

  // Force manage.php on for this probe
  process.env.PRIMUS_USE_MANAGE_PHP = "true";

  const types = await bridge._internal.fetchUiFileTypes();
  console.log("fileTypes count:", types.length);
  const quoteish = types.filter((t) => {
    const name = String(
        t.name || t.description || t.typeName || t.fileTypeName || "",
    );
    return /quote|approv|qa\b/i.test(name);
  });
  console.log("quote/approval-ish types:");
  console.log(JSON.stringify(quoteish, null, 2));
  console.log("\nall type names:");
  for (const t of types) {
    const id = t.fileTypeId != null ? t.fileTypeId : t.type;
    const name = t.name || t.description || t.typeName || t.fileTypeName;
    const ext = t.external;
    console.log(`  ${id}\text=${ext}\t${name}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
