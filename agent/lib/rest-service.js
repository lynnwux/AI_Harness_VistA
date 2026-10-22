"use strict";
// Deploy and remove the Harness Equipment REST data service on VADEMO.
// Uses the VADEMO Atelier client (vademo.js) — never talks to VADEMO directly.
const fs = require("fs");
const path = require("path");

const HARNESS_DIR = path.resolve(__dirname, "../../harness");
const REST_CLASSES = ["Harness.Setup.cls", "Harness.Equipment6914.API.cls", "Harness.Equipment.REST.cls"];
const REST_WEB_APP = "/Harness/Equipment";
const REST_TEARDOWN_CLASSES = ["Harness.Equipment.REST.cls", "Harness.Equipment6914.API.cls", "Harness.EquipmentAPI.cls"];

// Upload all three service classes, compile in one shot, then create/update the web app via SQL.
async function deployRestService(client, { sourceDir = HARNESS_DIR, log = () => {} } = {}) {
  for (const cls of REST_CLASSES) {
    log(`uploading ${cls}`);
    await client.putClass(cls, fs.readFileSync(path.join(sourceDir, cls), "utf8"));
  }
  log("compiling");
  await client.compile(REST_CLASSES);
  log("creating web app");
  const rows = await client.query("SELECT Harness.Setup_CreateWebApp() AS r");
  const r = ((rows[0] || {}).r || "");
  if (!/^(created|updated): \/Harness\/Equipment$/.test(r)) throw new Error(r);
  return { classes: REST_CLASSES, webApp: r.split(": ")[0] };
}

// Re-upload Setup.cls first so DeleteWebApp is available on a freshly reset VADEMO.
// Never throws — each item ends "removed", "absent", or "failed: <message>".
async function removeRestService(client, { sourceDir = HARNESS_DIR } = {}) {
  // Best-effort re-upload of Setup.cls (failures are silenced; the delete attempts still run).
  try {
    await client.putClass("Harness.Setup.cls", fs.readFileSync(path.join(sourceDir, "Harness.Setup.cls"), "utf8"));
    await client.compile(["Harness.Setup.cls"]);
  } catch (_) {}

  const results = [];

  // Delete the web app via the SQL proc.
  try {
    const rows = await client.query("SELECT Harness.Setup_DeleteWebApp() AS r");
    const r = ((rows[0] || {}).r || "");
    results.push({ item: `web app ${REST_WEB_APP}`, outcome: r.startsWith("deleted:") ? "removed" : r.startsWith("absent:") ? "absent" : `failed: ${r}` });
  } catch (e) {
    results.push({ item: `web app ${REST_WEB_APP}`, outcome: `failed: ${e.message}` });
  }

  // Delete each teardown class; 404 / absent means already gone.
  for (const cls of REST_TEARDOWN_CLASSES) {
    try {
      const o = await client.deleteClass(cls);
      results.push({ item: `class ${cls}`, outcome: o === "absent" ? "absent" : "removed" });
    } catch (e) {
      results.push({ item: `class ${cls}`, outcome: `failed: ${e.message}` });
    }
  }

  return results;
}

module.exports = { HARNESS_DIR, REST_CLASSES, REST_WEB_APP, REST_TEARDOWN_CLASSES, deployRestService, removeRestService };
