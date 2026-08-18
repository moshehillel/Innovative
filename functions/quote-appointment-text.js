/**
 * Appointment phrasing in RFQ emails.
 * Leaf module — do not require quote-accessorial-rules or catalog.
 */

"use strict";

/**
 * Customer said appointment is not needed — APD/APO must not apply.
 * Negative phrasing wins over a bare "appointment" keyword.
 */
const NO_APPOINTMENT_RE = new RegExp(
    "\\b(?:" +
    "no\\s+(?:delivery\\s+)?(?:appointments?|appts?)" +
    "(?:\\s*(?:necessary|needed|required))?" +
    "|(?:appointment|appt)s?\\s+not\\s+(?:necessary|needed|required)" +
    "|(?:appointment|appt)s?\\s+unnecessary" +
    ")\\b",
    "i");

/**
 * @param {string} text Subject + body + instructions.
 * @return {boolean}
 */
function declinesAppointmentDelivery(text) {
  return NO_APPOINTMENT_RE.test(String(text || ""));
}

module.exports = {
  declinesAppointmentDelivery,
};
