/**
 * Serves the Jerry support-chat embed (JS + logo) for the invoice dashboard.
 */

"use strict";

const fs = require("fs");
const path = require("path");

let deps = {};

/**
 * @param {object} d applyDashboardCors.
 */
function init(d) {
  deps = d;
}

/**
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {boolean}
 */
function cors(req, res) {
  return deps.applyDashboardCors(req, res);
}

/**
 * GET embeddable support-chat widget script.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {void}
 */
function handleJerrySupportChatWidget(req, res) {
  if (cors(req, res)) return;
  try {
    const js = fs.readFileSync(
        path.join(__dirname, "static", "jerry-support-chat.js"),
        "utf8",
    );
    res.set("Content-Type", "application/javascript; charset=utf-8");
    res.set("Cache-Control", "public, max-age=300, must-revalidate");
    return res.status(200).send(js);
  } catch (err) {
    console.error("jerrySupportChatWidget:", err);
    return res.status(500).send(`// ${err.message}`);
  }
}

/**
 * GET round Jerry / Innovative Carriers logo for the chat FAB.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {void}
 */
function handleJerrySupportChatLogo(req, res) {
  if (cors(req, res)) return;
  try {
    const logoPath = path.join(
        __dirname, "assets", "innovative-carriers-logo.png",
    );
    const buf = fs.readFileSync(logoPath);
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=86400");
    return res.status(200).send(buf);
  } catch (err) {
    console.error("jerrySupportChatLogo:", err);
    return res.status(500).json({ok: false, error: err.message});
  }
}

module.exports = {
  init,
  handleJerrySupportChatWidget,
  handleJerrySupportChatLogo,
};
