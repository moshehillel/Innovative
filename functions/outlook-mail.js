"use strict";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TOKEN_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const AUTH_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";

const SCOPES = [
  "openid",
  "profile",
  "offline_access",
  "User.Read",
  "Mail.ReadWrite",
  "Mail.Send",
].join(" ");

/**
 * @return {{clientId: string, clientSecret: string, redirectUri: string}}
 */
function getOutlookOAuthConfig() {
  const clientId = process.env.OUTLOOK_CLIENT_ID || "";
  const clientSecret = process.env.OUTLOOK_CLIENT_SECRET || "";
  const redirectUri = process.env.OUTLOOK_REDIRECT_URI || "";
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
        "OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET, and " +
        "OUTLOOK_REDIRECT_URI must be set for Outlook mail.",
    );
  }
  return {clientId, clientSecret, redirectUri};
}

/**
 * @param {object} addr Graph emailAddress object.
 * @return {string}
 */
function formatGraphAddress(addr) {
  if (!addr || !addr.emailAddress) return "";
  const name = addr.emailAddress.name || "";
  const email = addr.emailAddress.address || "";
  if (name && email) return `${name} <${email}>`;
  return email || name;
}

/**
 * @param {string} data Base64url or standard base64.
 * @return {Buffer}
 */
function decodeBase64Payload(data) {
  return Buffer.from(
      String(data || "").replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
  );
}

/**
 * @param {Buffer} buf Raw bytes.
 * @return {string} Base64url without padding.
 */
function toBase64Url(buf) {
  return Buffer.from(buf).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * @param {string} q Gmail-style query string.
 * @return {Date|null}
 */
function parseGmailAfterDate(q) {
  const m = String(q || "").match(/after:(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

/**
 * @param {object} tokens Stored OAuth tokens.
 * @return {object} Tokens with expires_at when missing.
 */
function normalizeTokenExpiry(tokens) {
  const t = {...tokens};
  if (!t.expires_at && t.expires_in) {
    t.expires_at = Date.now() + (Number(t.expires_in) * 1000);
  }
  return t;
}

/**
 * @param {object} tokens OAuth tokens.
 * @param {Function} onTokenUpdate Persist refreshed tokens.
 * @return {Promise<object>} Tokens with a valid access_token.
 */
async function getValidTokens(tokens, onTokenUpdate) {
  let t = normalizeTokenExpiry({...tokens});
  const expiresAt = Number(t.expires_at || 0);
  if (t.access_token && Date.now() < expiresAt - 60000) {
    return t;
  }
  if (!t.refresh_token) {
    throw new Error("Outlook token expired and no refresh token is available.");
  }
  const cfg = getOutlookOAuthConfig();
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: t.refresh_token,
    grant_type: "refresh_token",
    scope: SCOPES,
  });
  const resp = await fetch(TOKEN_URL, {method: "POST", body});
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Outlook token refresh failed: ${text}`);
  }
  const refreshed = JSON.parse(text);
  t = normalizeTokenExpiry({
    ...t,
    ...refreshed,
    refresh_token: refreshed.refresh_token || t.refresh_token,
  });
  if (onTokenUpdate) {
    await onTokenUpdate(t);
  }
  return t;
}

/**
 * @param {string} url Full Graph URL or path.
 * @param {object} tokens OAuth tokens.
 * @param {Function} onTokenUpdate Token persistence callback.
 * @param {object} [options] Fetch options.
 * @return {Promise<object|string|Buffer>}
 */
async function graphFetch(url, tokens, onTokenUpdate, options = {}) {
  const valid = await getValidTokens(tokens, onTokenUpdate);
  const fullUrl = url.startsWith("http") ? url :
    `${GRAPH_BASE}${url.startsWith("/") ? "" : "/"}${url}`;
  const headers = {
    Authorization: `Bearer ${valid.access_token}`,
    ...(options.headers || {}),
  };
  const resp = await fetch(fullUrl, {...options, headers});
  if (resp.status === 204 || resp.status === 202) return null;
  const contentType = String(resp.headers.get("content-type") || "");
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Graph API ${resp.status}: ${errText}`);
  }
  if (options.rawBinary) {
    return Buffer.from(await resp.arrayBuffer());
  }
  if (contentType.includes("text/plain") && options.expectText) {
    return resp.text();
  }
  if (contentType.includes("application/json")) {
    return resp.json();
  }
  return resp.text();
}

/**
 * @param {object} msg Graph message.
 * @param {Array<object>} attachments Graph attachment list.
 * @return {object} Gmail-style payload.
 */
function graphMessageToGmailPayload(msg, attachments) {
  const headers = [
    {name: "Subject", value: msg.subject || ""},
    {name: "From", value: formatGraphAddress(msg.from)},
    {
      name: "To",
      value: (msg.toRecipients || []).map(formatGraphAddress).join(", "),
    },
  ];

  const parts = [];
  if (msg.body && msg.body.content != null) {
    const isHtml = String(msg.body.contentType || "").toLowerCase() === "html";
    parts.push({
      mimeType: isHtml ? "text/html" : "text/plain",
      body: {data: toBase64Url(Buffer.from(msg.body.content, "utf8"))},
    });
  }

  for (const att of attachments || []) {
    const odataType = String(att["@odata.type"] || "");
    if (odataType.endsWith("fileAttachment")) {
      parts.push({
        filename: att.name || "attachment",
        mimeType: att.contentType || "application/octet-stream",
        body: {
          attachmentId: att.id,
          size: att.size || 0,
        },
      });
      continue;
    }
    if (odataType.endsWith("itemAttachment")) {
      parts.push({
        filename: `${att.name || "message"}.eml`,
        mimeType: "message/rfc822",
        unwrap: true,
        body: {attachmentId: att.id},
      });
    }
  }

  if (parts.length === 1 && !parts[0].filename) {
    return {
      headers,
      mimeType: parts[0].mimeType,
      body: parts[0].body,
    };
  }

  return {
    headers,
    mimeType: "multipart/mixed",
    parts,
  };
}

/**
 * @param {string} headerValue Raw To/Cc header.
 * @return {Array<object>} Graph recipient objects.
 */
function parseGraphRecipients(headerValue) {
  const raw = String(headerValue || "").trim();
  if (!raw) return [];
  const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const seen = new Set();
  const out = [];
  let match;
  while ((match = re.exec(raw))) {
    const addr = match[0];
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({emailAddress: {address: addr}});
  }
  return out;
}

/**
 * @param {string} headers MIME header block.
 * @param {string} name Header name.
 * @return {string|null}
 */
function getMimeHeader(headers, name) {
  const re = new RegExp(`^${name}:\\s*(.+)$`, "im");
  const hit = headers.match(re);
  return hit ? hit[1].trim() : null;
}

/**
 * @param {string} contentTypeHeader Content-Type header value.
 * @return {string}
 */
function mimeCharset(contentTypeHeader) {
  const m = String(contentTypeHeader || "")
      .match(/charset="?([^";\s]+)"?/i);
  return m ? m[1].toLowerCase() : "utf-8";
}

/**
 * Reconstruct UTF-8 text from a latin1-preserved MIME byte string.
 * @param {string} raw Latin1-preserved MIME bytes as a JS string.
 * @param {string} [charset] Declared charset (default utf-8).
 * @return {string}
 */
function decodeMimeUtf8Text(raw, charset) {
  const buf = Buffer.from(String(raw || ""), "latin1");
  const cs = String(charset || "utf-8").toLowerCase();
  if (cs.includes("utf-8") || cs.includes("utf8")) {
    return buf.toString("utf8");
  }
  return buf.toString("latin1");
}

/**
 * @param {string} partHeaders MIME part headers.
 * @param {string} partBody MIME part body.
 * @return {string} Decoded part text.
 */
function decodeMimePartBody(partHeaders, partBody) {
  const encoding = (getMimeHeader(partHeaders, "Content-Transfer-Encoding") ||
    "").toLowerCase();
  const charset = mimeCharset(getMimeHeader(partHeaders, "Content-Type"));
  if (encoding === "base64") {
    return Buffer.from(partBody.replace(/\s/g, ""), "base64").toString("utf8");
  }
  return decodeMimeUtf8Text(partBody, charset);
}

/**
 * Parses Jerry outbound MIME into a Graph sendMail message.
 * @param {Buffer} mimeBuffer Raw MIME bytes.
 * @return {object} Graph message object.
 */
function parseOutboundMimeForGraph(mimeBuffer) {
  const raw = mimeBuffer.toString("latin1");
  const splitAt = raw.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
  const splitIdx = raw.indexOf(splitAt);
  const headerBlock = splitIdx >= 0 ? raw.slice(0, splitIdx) : raw;
  const bodyBlock = splitIdx >= 0 ? raw.slice(splitIdx + splitAt.length) : "";

  const subject = decodeMimeUtf8Text(
      getMimeHeader(headerBlock, "Subject") || "",
  );
  const toRecipients = parseGraphRecipients(getMimeHeader(headerBlock, "To"));
  const ccRecipients = parseGraphRecipients(getMimeHeader(headerBlock, "Cc"));

  const contentType = getMimeHeader(headerBlock, "Content-Type") || "";
  let html = "";
  const attachments = [];

  const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = bodyBlock.split(`--${boundary}`)
        .map((part) => part.trim())
        .filter((part) => part && part !== "--");
    for (const part of parts) {
      const partSplit = part.includes("\r\n\r\n") ?
        part.indexOf("\r\n\r\n") : part.indexOf("\n\n");
      if (partSplit < 0) continue;
      const partHeaders = part.slice(0, partSplit);
      const bodyOffset = part.includes("\r\n\r\n") ? 4 : 2;
      let partBody = part.slice(partSplit + bodyOffset);
      partBody = partBody.replace(/[\r\n]+$/, "");
      const partType = getMimeHeader(partHeaders, "Content-Type") || "";
      const disposition =
        getMimeHeader(partHeaders, "Content-Disposition") || "";
      const nameMatch = disposition.match(/filename="([^"]+)"/i) ||
        partType.match(/name="([^"]+)"/i);
      const filename = nameMatch ? nameMatch[1] : "attachment";

      if (partType.includes("text/html") && !html) {
        html = decodeMimePartBody(partHeaders, partBody);
        continue;
      }
      if (partType.includes("text/plain") && !html) {
        const plain = decodeMimePartBody(partHeaders, partBody);
        html = `<pre>${plain.replace(/</g, "&lt;")}</pre>`;
        continue;
      }

      const encoding = (
        getMimeHeader(partHeaders, "Content-Transfer-Encoding") || ""
      ).toLowerCase();
      const contentBytes = encoding === "base64" ?
        partBody.replace(/\s/g, "") :
        Buffer.from(partBody, "latin1").toString("base64");
      const mimeType =
        partType.split(";")[0].trim() || "application/octet-stream";
      const contentIdRaw = getMimeHeader(partHeaders, "Content-ID") || "";
      const contentId = contentIdRaw.replace(/^<|>$/g, "");
      const isInline = disposition.toLowerCase().includes("inline") ||
        Boolean(contentId);
      attachments.push({
        "@odata.type": "#microsoft.graph.fileAttachment",
        "name": filename,
        "contentType": mimeType,
        "contentBytes": contentBytes,
        ...(isInline && contentId ? {
          isInline: true,
          contentId,
        } : {}),
      });
    }
  } else if (contentType.includes("text/html")) {
    html = decodeMimePartBody(headerBlock, bodyBlock.trim());
  } else {
    const plain = decodeMimePartBody(headerBlock, bodyBlock.trim());
    html = `<pre>${plain.replace(/</g, "&lt;")}</pre>`;
  }

  if (!toRecipients.length) {
    throw new Error("Outbound MIME has no To recipients.");
  }

  const message = {
    subject,
    body: {contentType: "HTML", content: html || ""},
    toRecipients,
  };
  if (ccRecipients.length) {
    message.ccRecipients = ccRecipients;
  }
  if (attachments.length) {
    message.attachments = attachments;
  }
  return message;
}

/**
 * Sends outbound MIME via Graph sendMail (reliable external delivery).
 * @param {Buffer} mimeBuffer Raw MIME bytes.
 * @param {object} tokens OAuth tokens.
 * @param {Function} onTokenUpdate Persist refreshed tokens.
 * @return {Promise<void>}
 */
async function sendOutboundMimeViaGraph(mimeBuffer, tokens, onTokenUpdate) {
  const message = parseOutboundMimeForGraph(mimeBuffer);
  const toAddrs = (message.toRecipients || [])
      .map((r) => r.emailAddress && r.emailAddress.address)
      .filter(Boolean);
  console.log("Outlook sendMail:", {
    subject: message.subject,
    to: toAddrs,
    cc: (message.ccRecipients || [])
        .map((r) => r.emailAddress && r.emailAddress.address)
        .filter(Boolean),
    attachmentCount: (message.attachments || []).length,
  });
  await graphFetch("/me/sendMail", tokens, onTokenUpdate, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({message, saveToSentItems: true}),
  });
}

/**
 * Extracts bare email from "Name <email>" or raw address.
 * @param {string} raw From/to string.
 * @return {string|null}
 */
function extractEmailAddress(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const angle = s.match(/<([^>]+)>/);
  if (angle) return angle[1].trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return s;
  const loose = s.match(/[^\s<>"]+@[^\s<>"]+/);
  return loose ? loose[0] : null;
}

/**
 * Sends a simple Graph sendMail message (quote replies, etc.).
 * @param {object} opts to, subject, bodyText, bodyHtml, cc, internetMessageId.
 * @param {object} tokens OAuth tokens.
 * @param {Function} onTokenUpdate Persist refreshed tokens.
 * @return {Promise<object>}
 */
async function sendSimpleMail(opts, tokens, onTokenUpdate) {
  const toList = [].concat(opts.to || [])
      .map(extractEmailAddress)
      .filter(Boolean);
  if (!toList.length) {
    throw new Error("No recipient email address for send");
  }
  const ccList = [].concat(opts.cc || [])
      .map(extractEmailAddress)
      .filter(Boolean);
  const useHtml = !!(opts.bodyHtml && String(opts.bodyHtml).trim());
  const message = {
    subject: String(opts.subject || "(no subject)"),
    body: {
      contentType: useHtml ? "HTML" : "Text",
      content: useHtml ?
        String(opts.bodyHtml) :
        String(opts.bodyText || ""),
    },
    toRecipients: toList.map((address) => ({
      emailAddress: {address},
    })),
  };
  if (ccList.length) {
    message.ccRecipients = ccList.map((address) => ({
      emailAddress: {address},
    }));
  }
  if (opts.internetMessageId) {
    message.internetMessageHeaders = [{
      name: "In-Reply-To",
      value: String(opts.internetMessageId),
    }, {
      name: "References",
      value: String(opts.internetMessageId),
    }];
  }
  console.log("Outlook sendSimpleMail:", {
    subject: message.subject,
    to: toList,
    cc: ccList,
  });
  await graphFetch("/me/sendMail", tokens, onTokenUpdate, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({message, saveToSentItems: true}),
  });
  return {ok: true, to: toList, subject: message.subject};
}

/**
 * Builds a Gmail-compatible client backed by Microsoft Graph.
 * @param {object} tokens OAuth tokens.
 * @param {Function} onTokenUpdate Persist refreshed tokens.
 * @return {object} Gmail-shaped API client.
 */
function buildOutlookMailAdapter(tokens, onTokenUpdate) {
  const api = {
    users: {
      messages: {
        list: async ({
          maxResults = 50,
          pageToken,
          q,
          includeRead,
          readAfter,
          readBefore,
          readMode,
        } = {}) => {
          let url;
          if (pageToken) {
            url = pageToken;
          } else {
            const readAfterDate = readAfter ?
              (readAfter instanceof Date ? readAfter : new Date(readAfter)) :
              null;
            const readBeforeDate = readBefore ?
              (readBefore instanceof Date ? readBefore : new Date(readBefore)) :
              null;
            const mode = String(readMode || "openedSince").toLowerCase();
            let filter;
            let orderBy;
            if (readAfterDate && !isNaN(readAfterDate.getTime())) {
              if (mode === "received") {
                filter = "isRead eq true and receivedDateTime ge " +
                  readAfterDate.toISOString();
                if (readBeforeDate && !isNaN(readBeforeDate.getTime())) {
                  filter += " and receivedDateTime le " +
                    readBeforeDate.toISOString();
                }
                orderBy = "receivedDateTime desc";
              } else {
                // openedSince / modified: lastModified proxy for mark-as-read.
                // Do not cap on server — until is applied client-side for
                // modified mode only (avoids missing mail touched after until).
                filter = "isRead eq true and lastModifiedDateTime ge " +
                  readAfterDate.toISOString();
                orderBy = "lastModifiedDateTime desc";
              }
            } else {
              const after = parseGmailAfterDate(q);
              filter = includeRead ? "" : "isRead eq false";
              if (after) {
                const dateClause = `receivedDateTime ge ${after.toISOString()}`;
                filter = filter ? `${filter} and ${dateClause}` : dateClause;
              }
              if (!filter) {
                filter = "receivedDateTime ge 1970-01-01T00:00:00Z";
              }
              orderBy = "receivedDateTime desc";
            }
            const params = new URLSearchParams({
              "$filter": filter,
              "$select": "id",
              "$top": String(maxResults),
              "$orderby": orderBy,
            });
            url = `/me/mailFolders/inbox/messages?${params.toString()}`;
          }
          const resp = await graphFetch(url, tokens, onTokenUpdate);
          return {
            data: {
              messages: (resp.value || []).map((m) => ({id: m.id})),
              nextPageToken: resp["@odata.nextLink"] || null,
            },
          };
        },

        get: async ({id, format, metadataHeaders}) => {
          if (format === "raw") {
            const rawMime = await graphFetch(
                `/me/messages/${encodeURIComponent(id)}/$value`,
                tokens,
                onTokenUpdate,
                {rawBinary: true},
            );
            return {data: {raw: toBase64Url(rawMime), id}};
          }

          if (format === "metadata") {
            const msg = await graphFetch(
                `/me/messages/${encodeURIComponent(id)}` +
                "?$select=id,subject,from,receivedDateTime," +
                "lastModifiedDateTime,isRead",
                tokens,
                onTokenUpdate,
            );
            const headers = [];
            if (Array.isArray(metadataHeaders)) {
              if (metadataHeaders.includes("Subject")) {
                headers.push({name: "Subject", value: msg.subject || ""});
              }
              if (metadataHeaders.includes("From")) {
                headers.push({
                  name: "From",
                  value: formatGraphAddress(msg.from),
                });
              }
            }
            const readMs = msg.lastModifiedDateTime ?
              new Date(msg.lastModifiedDateTime).getTime() : 0;
            const receivedMs = msg.receivedDateTime ?
              new Date(msg.receivedDateTime).getTime() : 0;
            return {
              data: {
                id: msg.id,
                internalDate: String(readMs || receivedMs || 0),
                readModifiedDateTime: msg.lastModifiedDateTime || null,
                receivedDateTime: msg.receivedDateTime || null,
                isRead: Boolean(msg.isRead),
                payload: {headers},
              },
            };
          }

          const msg = await graphFetch(
              `/me/messages/${encodeURIComponent(id)}` +
              "?$select=id,subject,from,toRecipients,body,hasAttachments",
              tokens,
              onTokenUpdate,
          );
          let attachments = [];
          if (msg.hasAttachments) {
            const attResp = await graphFetch(
                `/me/messages/${encodeURIComponent(id)}/attachments` +
                "?$select=id,name,contentType,size,isInline",
                tokens,
                onTokenUpdate,
            );
            attachments = (attResp.value || [])
                .filter((a) => !a.isInline)
                .map((a) => ({
                  ...a,
                  "@odata.type": a["@odata.type"] ||
                    "#microsoft.graph.fileAttachment",
                }));
          }
          return {
            data: {
              id: msg.id,
              payload: graphMessageToGmailPayload(msg, attachments),
            },
          };
        },

        send: async ({requestBody: {raw}} = {}) => {
          const mimeBuffer = decodeBase64Payload(raw);
          await sendOutboundMimeViaGraph(mimeBuffer, tokens, onTokenUpdate);
          return {data: {id: "sent"}};
        },

        modify: async ({id, requestBody: {removeLabelIds} = {}} = {}) => {
          if (Array.isArray(removeLabelIds) &&
              removeLabelIds.includes("UNREAD")) {
            await graphFetch(
                `/me/messages/${encodeURIComponent(id)}`,
                tokens,
                onTokenUpdate,
                {
                  method: "PATCH",
                  headers: {"Content-Type": "application/json"},
                  body: JSON.stringify({isRead: true}),
                },
            );
          }
          return {data: {id}};
        },

        attachments: {
          get: async ({messageId, id: attachmentId}) => {
            const meta = await graphFetch(
                `/me/messages/${encodeURIComponent(messageId)}/attachments/` +
                `${encodeURIComponent(attachmentId)}`,
                tokens,
                onTokenUpdate,
            );
            const odataType = String(meta["@odata.type"] || "");
            if (meta.contentBytes) {
              return {data: {data: toBase64Url(
                  Buffer.from(meta.contentBytes, "base64"),
              )}};
            }
            if (odataType.endsWith("itemAttachment")) {
              const raw = await graphFetch(
                  `/me/messages/${encodeURIComponent(messageId)}/attachments/` +
                  `${encodeURIComponent(attachmentId)}/$value`,
                  tokens,
                  onTokenUpdate,
                  {rawBinary: true},
              );
              return {data: {data: toBase64Url(raw)}};
            }
            const fileRaw = await graphFetch(
                `/me/messages/${encodeURIComponent(messageId)}/attachments/` +
                `${encodeURIComponent(attachmentId)}/$value`,
                tokens,
                onTokenUpdate,
                {rawBinary: true},
            );
            return {data: {data: toBase64Url(fileRaw)}};
          },
        },
      },
    },
  };
  return api;
}

/**
 * @param {object} tenant Tenant config (for OAuth state).
 * @return {string} Authorization URL.
 */
function buildOutlookConnectUrl(tenant) {
  const cfg = getOutlookOAuthConfig();
  const state = Buffer.from(JSON.stringify({
    tenantId: tenant && tenant.tenantId ? tenant.tenantId : "default",
  })).toString("base64url");
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: cfg.redirectUri,
    response_mode: "query",
    scope: SCOPES,
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/**
 * One-time URL for the customer's M365 admin to grant org-wide consent.
 * Send this to their Global Admin before users click Connect Outlook.
 * @return {string}
 */
function buildOutlookAdminConsentUrl() {
  const cfg = getOutlookOAuthConfig();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
  });
  return `https://login.microsoftonline.com/organizations/adminconsent?` +
    params.toString();
}

/**
 * @param {string} code OAuth authorization code.
 * @param {string} [redirectUri] Optional redirect URI override.
 * @return {Promise<object>} Token payload with expires_at.
 */
async function exchangeOutlookCode(code, redirectUri) {
  const cfg = getOutlookOAuthConfig();
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: redirectUri || cfg.redirectUri,
    grant_type: "authorization_code",
    scope: SCOPES,
  });
  const resp = await fetch(TOKEN_URL, {method: "POST", body});
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Outlook OAuth token exchange failed: ${text}`);
  }
  const tokens = JSON.parse(text);
  return normalizeTokenExpiry(tokens);
}

/**
 * @param {object} tokens Stored tokens.
 * @param {Function} onTokenUpdate Refresh persistence callback.
 * @return {object} Gmail-compatible mail client.
 */
function createOutlookMailClient(tokens, onTokenUpdate) {
  return buildOutlookMailAdapter(tokens, onTokenUpdate);
}

/**
 * Returns the Outlook mailbox profile for connected OAuth tokens.
 * @param {object} tokens OAuth tokens.
 * @param {Function} [onTokenUpdate] Persist refreshed tokens.
 * @return {Promise<object>} Profile with email and displayName fields.
 */
async function fetchMailboxProfile(tokens, onTokenUpdate) {
  const me = await graphFetch(
      "/me?$select=displayName,mail,userPrincipalName",
      tokens,
      onTokenUpdate,
  );
  return {
    email: (me && (me.mail || me.userPrincipalName)) || null,
    displayName: (me && me.displayName) || null,
  };
}

module.exports = {
  buildOutlookConnectUrl,
  buildOutlookAdminConsentUrl,
  exchangeOutlookCode,
  createOutlookMailClient,
  fetchMailboxProfile,
  getOutlookOAuthConfig,
  sendSimpleMail,
  extractEmailAddress,
};
