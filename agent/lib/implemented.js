"use strict";
// The `implemented` record: what has been built and verified.
// Normalizes the legacy flat-array api shape so callers never branch on it.

// Phase 1 REST services (verbatim from the spec).
const PHASE1_SERVICES = [
  { id: "write:6914",    endpoint: "POST /equipment",           what: "create a file-6914 record; body = the request contract; returns { status, equipmentIEN, lifecycleStatus }" },
  { id: "read:next-ien", endpoint: "GET /equipment/next-ien",   what: "returns { status, ien } — shown display-only; the POST allocates authoritatively" },
  { id: "read:lookup",   endpoint: "GET /lookup/{file}?q=",     what: "pointer-file search; returns { items: [{ ien, display }], total }; &all=1 returns every row" },
];

const emptyApi = () => ({ built: false, verified: false, services: [], verifiedRecord: null, builtFrom: null });
const emptyImplemented = () => ({ api: emptyApi(), orchestrator: { built: false, verified: false }, ai: { built: false, verified: false } });

// Normalize: old flat array → empty; missing api → empty; built:false → empty.
function apiRecord(im) {
  const a = im && im.api;
  if (!a || Array.isArray(a) || !a.built) return emptyApi();
  return { built: true, verified: !!a.verified, services: a.services || [], verifiedRecord: a.verifiedRecord || null, builtFrom: a.builtFrom || null };
}

const apiServices = im => { const r = apiRecord(im); return r.built ? r.services : []; };
const builtApi = (services = PHASE1_SERVICES, extra = {}) => ({ built: true, verified: true, services, verifiedRecord: null, builtFrom: null, ...extra });

module.exports = { PHASE1_SERVICES, emptyImplemented, apiRecord, apiServices, builtApi };
