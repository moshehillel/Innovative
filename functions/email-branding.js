"use strict";

const fs = require("fs");
const path = require("path");

const LOGO_CID = "innovative-carriers-logo";
const LOGO_FILENAME = "innovative-carriers-logo.png";
const LOGO_PATH = path.join(__dirname, "assets", LOGO_FILENAME);

let cachedLogoBase64 = null;

/**
 * @return {Buffer}
 */
function getLogoBuffer() {
  return fs.readFileSync(LOGO_PATH);
}

/**
 * @return {string}
 */
function getLogoBase64() {
  if (!cachedLogoBase64) {
    cachedLogoBase64 = getLogoBuffer().toString("base64");
  }
  return cachedLogoBase64;
}

/**
 * @param {object} [opts]
 * @param {"cid"|"data"} [opts.mode] cid for MIME inline; data for Primus HTML.
 * @param {number} [opts.maxWidth] Max display width in pixels.
 * @return {string}
 */
function innovativeCarriersLogoHtml(opts = {}) {
  const mode = opts.mode === "data" ? "data" : "cid";
  const maxWidth = opts.maxWidth != null ? Number(opts.maxWidth) : 320;
  const style = `max-width:${maxWidth}px;height:auto;display:block;border:0;` +
    "margin:0 0 12px;";
  if (mode === "data") {
    return `<img src="data:image/png;base64,${getLogoBase64()}" ` +
      `alt="Innovative Carriers" style="${style}" />`;
  }
  return `<img src="cid:${LOGO_CID}" alt="Innovative Carriers" ` +
    `style="${style}" />`;
}

/**
 * Inline MIME attachment for Jerry outbound emails (Outlook/Gmail).
 * @return {object}
 */
function innovativeCarriersLogoInlineAttachment() {
  return {
    inline: true,
    contentId: LOGO_CID,
    filename: LOGO_FILENAME,
    contentType: "image/png",
    contentBase64: getLogoBase64(),
  };
}

module.exports = {
  LOGO_CID,
  innovativeCarriersLogoHtml,
  innovativeCarriersLogoInlineAttachment,
};
