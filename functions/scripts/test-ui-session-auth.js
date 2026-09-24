/* eslint-disable no-console */
"use strict";

const {isUiSessionAuthFailure} = require("../primus-ui-bridge")._internal;

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}` +
    (ok ? "" : `\n  got: ${actual}\n  exp: ${expected}`));
};

const vendorBook = JSON.stringify({
  vendors: [{
    id: "129451",
    name: "Example Carrier",
    vendorEmail: "carrierlogin@example.com",
    type: "LTL",
  }],
});

check("vendor JSON with login inside an email is not a dead session",
    isUiSessionAuthFailure(200, vendorBook), false);
check("plain No session started is a dead session",
    isUiSessionAuthFailure(200, "No session started."), true);
check("JSON session phrase is still a dead session",
    isUiSessionAuthFailure(200,
        "{\"message\":\"No session started.\"}"), true);
check("HTTP 401 is a dead session",
    isUiSessionAuthFailure(401, "ok"), true);
check("short HTML login wall is a dead session",
    isUiSessionAuthFailure(200, "<html>Please login</html>"), true);
check("successful vendor JSON without login is not a dead session",
    isUiSessionAuthFailure(200, "{\"vendors\":[]}"), false);

if (failures) {
  console.error(failures + " failed");
  process.exit(1);
}
console.log("all passed");
