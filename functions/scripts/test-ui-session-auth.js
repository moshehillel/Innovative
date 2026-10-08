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

const getVendorsBook = JSON.stringify({
  vendors: [
    {
      id: "137766",
      name: "UZ SAM TRANS INC",
      vendorEmail: "arialoginC@gmail.com",
    },
    {
      id: "129451",
      name: "Other Carrier",
      vendorEmail: "jjloginc@gmail.com",
    },
    {
      id: "3",
      name: "Word Boundary Carrier",
      vendorEmail: "login@gmail.com",
    },
  ],
});

check("vendor JSON with login inside an email is not a dead session",
    isUiSessionAuthFailure(200, vendorBook), false);
check("getVendors JSON with arialoginC and jjloginc is not a dead session",
    isUiSessionAuthFailure(200, getVendorsBook), false);
check("BOM-prefixed getVendors JSON is not a dead session",
    isUiSessionAuthFailure(200, "\uFEFF" + getVendorsBook), false);
check("bare login@gmail.com email is not a dead session",
    isUiSessionAuthFailure(200, "login@gmail.com"), false);
check("HTML vendor dump of those emails is not a dead session",
    isUiSessionAuthFailure(200,
        "<html><body>arialoginC@gmail.com jjloginc@gmail.com</body></html>"),
    false);
check("plain No session started is a dead session",
    isUiSessionAuthFailure(200, "No session started."), true);
check("JSON session phrase is still a dead session",
    isUiSessionAuthFailure(200,
        "{\"message\":\"No session started.\"}"), true);
check("HTTP 401 is a dead session",
    isUiSessionAuthFailure(401, "ok"), true);
check("short HTML login wall is a dead session",
    isUiSessionAuthFailure(200, "<html>Please login</html>"), true);
check("redirect to a login URL is a dead session",
    isUiSessionAuthFailure(302, "", "https://shipprimus.com/login"), true);
check("manage.php URL is not a login redirect",
    isUiSessionAuthFailure(
        200, getVendorsBook,
        "https://shipprimus.com/PRIMUS/trunk/manage.php"),
    false);
check("successful vendor JSON without login is not a dead session",
    isUiSessionAuthFailure(200, "{\"vendors\":[]}"), false);

if (failures) {
  console.error(failures + " failed");
  process.exit(1);
}
console.log("all passed");
