# Payment-notification classifier bake-off

At: 2026-09-03T23:13:11.701Z
Winner: **gpt-4o**
Default wired: `gpt-5.6-luna`

| Model | Score | Avg ms | Misses |
| --- | --- | --- | --- |
| `gpt-4o` | 10/10 | 3236 | — |
| `gpt-4.1` | 10/10 | 4008 | — |
| `gpt-5.6-luna` | 10/10 | 4745 | — |
| `gpt-5.6-sol` | 10/10 | 4801 | — |

## Per-case detail

### gpt-5.6-luna
- ✓ **CHB-266272**: expect `freight_invoice` got `freight_invoice` (5793ms) — The subject references an invoice, CR number, and BOL, and the message concerns attached customs documents; the quoted banking information is not a bank alert.
- ✓ **HEYPHARMA-BOL-ZELLE-QUOTE**: expect `freight_invoice` got `freight_invoice` (4592ms) — The email contains an invoice attachment and a BOL number, while the quoted banking information does not change its classification.
- ✓ **BOA-ZELLE-ALERT**: expect `bank_payment_alert` got `bank_payment_alert` (4257ms) — This is an automated Bank of America Zelle alert stating that money was received.
- ✓ **CHASE-QUICKPAY-ALERT**: expect `bank_payment_alert` got `bank_payment_alert` (4171ms) — This is an automated Chase Zelle notification stating that money was received.
- ✓ **BERKSHIRE-WIRE-REMIT**: expect `customer_remittance` got `customer_remittance` (4089ms) — The customer says they wired $12,155.00 and attached payment confirmations.
- ✓ **ALTAREB-PAID-REPLY**: expect `customer_remittance` got `customer_remittance` (6724ms) — The customer states that payment was sent via Zelle and paid in full for the referenced invoice; the quoted banking instructions are not a bank alert.
- ✓ **CARRIER-INVOICE-ARCBEST**: expect `freight_invoice` got `freight_invoice` (4047ms) — The email is from a carrier and includes an attached invoice for a listed pronumber.
- ✓ **AMFAST-QB-ZELLE-TIP**: expect `freight_invoice` got `freight_invoice` (5647ms) — This is an invoice from a freight company with a balance due, and the quoted Zelle/QuickPay instructions do not make it a bank payment alert.
- ✓ **AMBIGUOUS-ZELLE-NO-BANK-FROM**: expect `other` got `other` (4126ms) — The message is an unclear payment inquiry from an unknown sender, not an actual bank alert or customer remittance.
- ✓ **BOA-ACH-ALERT**: expect `bank_payment_alert` got `bank_payment_alert` (4004ms) — This is an automated Bank of America alert stating that an ACH payment was received.

### gpt-5.6-sol
- ✓ **CHB-266272**: expect `freight_invoice` got `freight_invoice` (4716ms) — The subject contains invoice, CR, and BOL numbers and the message concerns customs documents; the quoted Zelle information is only prior banking guidance.
- ✓ **HEYPHARMA-BOL-ZELLE-QUOTE**: expect `freight_invoice` got `freight_invoice` (5043ms) — The sender attached an invoice for BOL#265028, while the Quickpay/Zelle text is only quoted from a prior reply.
- ✓ **BOA-ZELLE-ALERT**: expect `bank_payment_alert` got `bank_payment_alert` (4476ms) — This is an automated Bank of America Zelle alert confirming receipt of a $36 payment.
- ✓ **CHASE-QUICKPAY-ALERT**: expect `bank_payment_alert` got `bank_payment_alert` (5171ms) — This is an automated Chase alert confirming receipt of a Zelle payment.
- ✓ **BERKSHIRE-WIRE-REMIT**: expect `customer_remittance` got `customer_remittance` (4383ms) — The customer states they wired payment and attached payment confirmation.
- ✓ **ALTAREB-PAID-REPLY**: expect `customer_remittance` got `customer_remittance` (4935ms) — The customer AP contact states that the invoice was paid in full via Zelle today.
- ✓ **CARRIER-INVOICE-ARCBEST**: expect `freight_invoice` got `freight_invoice` (4465ms) — ArcBest is sending an attached freight invoice for a specified PRO number.
- ✓ **AMFAST-QB-ZELLE-TIP**: expect `freight_invoice` got `freight_invoice` (4896ms) — This is a freight company invoice requesting payment, and the Zelle/QuickPay text is merely payment instructions.
- ✓ **AMBIGUOUS-ZELLE-NO-BANK-FROM**: expect `other` got `other` (5595ms) — This is an unclear FYI about Zelle, not an automated bank alert or a clear customer remittance.
- ✓ **BOA-ACH-ALERT**: expect `bank_payment_alert` got `bank_payment_alert` (4327ms) — This is an automated Bank of America ACH payment receipt alert.

### gpt-4.1
- ✓ **CHB-266272**: expect `freight_invoice` got `freight_invoice` (3971ms) — The subject includes invoice, CR, and BOL numbers, and the body references attached customs documents—this indicates a freight-related document, not a bank alert.
- ✓ **HEYPHARMA-BOL-ZELLE-QUOTE**: expect `freight_invoice` got `freight_invoice` (4035ms) — The email contains an attached invoice with a BOL number in the subject and body, and the banking information is only quoted from a prior response.
- ✓ **BOA-ZELLE-ALERT**: expect `bank_payment_alert` got `bank_payment_alert` (4039ms) — The email is a direct automated bank alert from ealerts.bankofamerica.com confirming receipt of a Zelle payment.
- ✓ **CHASE-QUICKPAY-ALERT**: expect `bank_payment_alert` got `bank_payment_alert` (3774ms) — The sender is a bank alert address and the body is an automated notice of a Zelle payment received.
- ✓ **BERKSHIRE-WIRE-REMIT**: expect `customer_remittance` got `customer_remittance` (4285ms) — The sender says they wired a payment and attached confirmation, indicating a customer remittance.
- ✓ **ALTAREB-PAID-REPLY**: expect `customer_remittance` got `customer_remittance` (3949ms) — The sender confirms payment was sent for a specific invoice and BOL, indicating a remittance from a customer.
- ✓ **CARRIER-INVOICE-ARCBEST**: expect `freight_invoice` got `freight_invoice` (3858ms) — The email is from a carrier with an invoice attached and references invoice numbers in the subject and body.
- ✓ **AMFAST-QB-ZELLE-TIP**: expect `freight_invoice` got `freight_invoice` (3983ms) — The email is sending an invoice from a carrier with details for payment; the banking instructions are quoted, not a bank alert.
- ✓ **AMBIGUOUS-ZELLE-NO-BANK-FROM**: expect `other` got `other` (3941ms) — The email is informational about Zelle and does not confirm a payment, contain an invoice, or match a bank alert.
- ✓ **BOA-ACH-ALERT**: expect `bank_payment_alert` got `bank_payment_alert` (4242ms) — The sender and content match an automated bank deposit alert notification.

### gpt-4o
- ✓ **CHB-266272**: expect `freight_invoice` got `freight_invoice` (3881ms) — The subject and body reference an invoice, CR number, and BOL, indicating it's related to freight documentation.
- ✓ **HEYPHARMA-BOL-ZELLE-QUOTE**: expect `freight_invoice` got `freight_invoice` (3815ms) — The email contains an attached invoice for a specific BOL number in the subject line.
- ✓ **BOA-ZELLE-ALERT**: expect `bank_payment_alert` got `bank_payment_alert` (3810ms) — The email is a direct bank alert from Bank of America about a received payment via Zelle.
- ✓ **CHASE-QUICKPAY-ALERT**: expect `bank_payment_alert` got `bank_payment_alert` (3825ms) — The email is from a bank alert domain and informs Innovative of a received Zelle payment, matching bank payment alert criteria.
- ✓ **BERKSHIRE-WIRE-REMIT**: expect `customer_remittance` got `customer_remittance` (3607ms) — The email is from a customer mentioning a wired payment with payment confirmation attached.
- ✓ **ALTAREB-PAID-REPLY**: expect `customer_remittance` got `customer_remittance` (3879ms) — The email clearly states that payment was sent via Zelle for a specific invoice, indicating a customer remittance.
- ✓ **CARRIER-INVOICE-ARCBEST**: expect `freight_invoice` got `freight_invoice` (3758ms) — The email contains invoice details and an attachment related to freight services.
- ✓ **AMFAST-QB-ZELLE-TIP**: expect `freight_invoice` got `freight_invoice` (3650ms) — The email contains an invoice number and a balance due, indicating it's related to a freight invoice.
- ✓ **AMBIGUOUS-ZELLE-NO-BANK-FROM**: expect `other` got `other` (887ms) — The email is an inquiry about Zelle, not an actual payment alert or remittance.
- ✓ **BOA-ACH-ALERT**: expect `bank_payment_alert` got `bank_payment_alert` (1251ms) — The email is from a bank alert domain indicating an ACH payment was received.
