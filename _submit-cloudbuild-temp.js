"use strict";

/**
 * Submit a Cloud Build from git HEAD.
 * Usage: node _submit-cloudbuild-temp.js [cloudbuild.yaml]
 */

const {spawnSync} = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const {GoogleAuth} = require("./functions/node_modules/google-auth-library");
const yaml = require("./functions/node_modules/js-yaml");

const PROJECT = "tai-invoice-automation";
const BUCKET = "tai-invoice-automation_cloudbuild";
const yamlPath = path.resolve(process.argv[2] || "_cloudbuild-quote-inbox-load-more.yaml");
/** Gitignored. Appended into the upload when present locally; never committed. */
const LOCAL_ENV_REL = "functions/.env.tai-invoice-automation";

/**
 * @return {Promise<string>}
 */
async function getAccessToken() {
  const auth = new GoogleAuth({
    projectId: PROJECT,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token.token) throw new Error("No access token");
  return token.token;
}

/**
 * @param {string} token Access token.
 * @param {string} objectName GCS object.
 * @param {Buffer} body Archive bytes.
 * @return {Promise<void>}
 */
async function upload(token, objectName, body) {
  const url =
    "https://storage.googleapis.com/upload/storage/v1/b/" + BUCKET +
    "/o?uploadType=media&name=" + encodeURIComponent(objectName);
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/gzip",
    },
    body,
  });
  if (!resp.ok) {
    throw new Error("Upload failed " + resp.status + " " +
      (await resp.text()).slice(0, 400));
  }
}

/**
 * @param {object} json Build create response.
 * @return {string}
 */
function buildIdFrom(json) {
  if (json && json.id) return json.id;
  if (json && json.metadata && json.metadata.build && json.metadata.build.id) {
    return json.metadata.build.id;
  }
  return "";
}

/**
 * git archive HEAD, then append the local functions env file when it exists.
 * The env file is gitignored, so git archive alone omits it and the next
 * firebase deploy falls back off Cursor. Never log file contents.
 * @return {Buffer} gzip archive
 */
function buildSourceArchive() {
  console.log("Archiving source from git HEAD...");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cb-src-"));
  try {
    const tarPath = path.join(tmp, "source.tar");
    const archived = spawnSync(
        "git",
        ["archive", "--format=tar", "--output=" + tarPath, "HEAD"],
        {stdio: "inherit"},
    );
    if (archived.status !== 0) {
      throw new Error("git archive failed (" + (archived.status || "signal") + ")");
    }
    const envAbs = path.resolve(__dirname, LOCAL_ENV_REL);
    if (fs.existsSync(envAbs)) {
      const stageDir = path.join(tmp, "stage");
      const stageFunctions = path.join(stageDir, "functions");
      fs.mkdirSync(stageFunctions, {recursive: true});
      fs.copyFileSync(
          envAbs,
          path.join(stageFunctions, ".env.tai-invoice-automation"),
      );
      const appended = spawnSync(
          "tar",
          ["-rf", tarPath, "functions/.env.tai-invoice-automation"],
          {cwd: stageDir, stdio: "inherit"},
      );
      if (appended.status !== 0) {
        throw new Error("tar append of " + LOCAL_ENV_REL + " failed");
      }
      console.log("Included local " + LOCAL_ENV_REL +
        " in Cloud Build source (not committed)");
    } else {
      console.log("Local " + LOCAL_ENV_REL +
        " not found; upload is git HEAD only");
    }
    const gz = zlib.gzipSync(fs.readFileSync(tarPath));
    console.log("Archive size " + (gz.length / 1024 / 1024).toFixed(2) + " MiB");
    return gz;
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
}

async function main() {
  const cfg = yaml.load(fs.readFileSync(yamlPath, "utf8"));
  const token = await getAccessToken();
  const archive = buildSourceArchive();
  const objectName = "source/" + Date.now() + "-" +
    crypto.randomBytes(6).toString("hex") + ".tgz";
  console.log("Uploading to GCS...");
  await upload(token, objectName, archive);
  console.log("Uploaded gs://" + BUCKET + "/" + objectName);

  const build = {
    source: {storageSource: {bucket: BUCKET, object: objectName}},
    steps: cfg.steps,
    timeout: cfg.timeout || "2400s",
    options: cfg.options || {logging: "CLOUD_LOGGING_ONLY"},
  };
  const createResp = await fetch(
      "https://cloudbuild.googleapis.com/v1/projects/" + PROJECT + "/builds",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(build),
      },
  );
  const createText = await createResp.text();
  if (!createResp.ok) {
    throw new Error("Build submit failed " + createResp.status + " " +
      createText.slice(0, 500));
  }
  const created = JSON.parse(createText);
  const id = buildIdFrom(created);
  if (!id) throw new Error("No build id: " + createText.slice(0, 400));
  console.log("Build id: " + id);
  console.log("Console: https://console.cloud.google.com/cloud-build/builds/" +
    id + "?project=" + PROJECT);

  for (;;) {
    await new Promise((r) => setTimeout(r, 15000));
    const poll = await fetch(
        "https://cloudbuild.googleapis.com/v1/projects/" + PROJECT +
        "/builds/" + id,
        {headers: {Authorization: "Bearer " + token}},
    );
    const body = await poll.json();
    const status = body.status || "UNKNOWN";
    console.log("[" + new Date().toISOString() + "] status=" + status);
    if (status === "SUCCESS") {
      console.log("SUCCESS");
      return;
    }
    if (["FAILURE", "INTERNAL_ERROR", "TIMEOUT", "CANCELLED", "EXPIRED"]
        .includes(status)) {
      throw new Error("Build " + status + " " + (body.statusDetail || ""));
    }
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
