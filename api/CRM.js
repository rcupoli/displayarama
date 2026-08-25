/**
 * Displayarama Executive Dashboard — API Proxy
 * Serverless function. PIT stays on the server, never in the browser.
 * ENDPOINTS (all under /api/CRM?resource=...):
 *   ping | pipelines | opportunities | contacts | users
 */
const BASE = "https://services.leadconnectorhq.com";

function jsonResponse(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.end(JSON.stringify(body));
}

async function ghlFetch(path, query, pit, version) {
  const qs = new URLSearchParams(query).toString();
  const url = `${BASE}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${pit}`,
      Version: version || "2021-07-28",
    },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: "Invalid JSON from API", raw: text }; }
  if (!res.ok) return { ok: false, status: res.status, body: json };
  return { ok: true, status: res.status, body: json };
}

async function fetchAllOpportunities(locationId, pit) {
  const all = [];
  let startAfter = null, startAfterId = null, pages = 0;
  while (pages < 200) {
    pages += 1;
    const query = { location_id: locationId, limit: "100", page: String(pages) };
    if (startAfter) query.startAfter = startAfter;
    if (startAfterId) query.startAfterId = startAfterId;
    const { ok, status, body } = await ghlFetch("/opportunities/search", query, pit, "2021-07-28");
    if (!ok) return { ok: false, status, body };
    const batch = body.opportunities || [];
    all.push(...batch);
    const meta = body.meta || {};
    startAfter = meta.startAfter || meta.start_after || null;
    startAfterId = meta.startAfterId || meta.start_after_id || null;
    if (batch.length < 100 || (!startAfter && !startAfterId)) break;
  }
  return { ok: true, body: { opportunities: all } };
}

async function fetchAllContacts(locationId, pit) {
  const all = [];
  let page = 0, pages = 0;
  while (pages < 200) {
    pages += 1; page += 1;
    const { ok, status, body } = await ghlFetch("/contacts/", { locationId, limit: "100", page: String(page) }, pit, "2021-07-28");
    if (!ok) return { ok: false, status, body };
    const batch = body.contacts || [];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return { ok: true, body: { contacts: all } };
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { jsonResponse(res, 204, {}); return; }
  const pit = process.env.GHL_PIT;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!pit || !locationId) {
    jsonResponse(res, 500, { error: "Server missing GHL_PIT or GHL_LOCATION_ID env vars." });
    return;
  }
  const url = new URL(req.url, "http://localhost");
  const resource = url.searchParams.get("resource") || "ping";
  try {
    if (resource === "ping") {
      const { ok, status, body } = await ghlFetch(`/locations/${locationId}`, {}, pit, "2021-07-28");
      jsonResponse(res, ok ? 200 : status, { ok, locationId, location: body });
      return;
    }
    if (resource === "pipelines") {
      const r = await ghlFetch("/opportunities/pipelines", { locationId }, pit, "2021-07-28");
      jsonResponse(res, r.ok ? 200 : r.status, r.body); return;
    }
    if (resource === "opportunities") {
      const r = await fetchAllOpportunities(locationId, pit);
      jsonResponse(res, r.ok ? 200 : r.status, r.body); return;
    }
    if (resource === "contacts") {
      const r = await fetchAllContacts(locationId, pit);
      jsonResponse(res, r.ok ? 200 : r.status, r.body); return;
    }
    if (resource === "users") {
      const r = await ghlFetch("/users/search", { locationId }, pit, "2021-07-28");
      jsonResponse(res, r.ok ? 200 : r.status, r.body); return;
    }
    jsonResponse(res, 404, { error: `Unknown resource: ${resource}` });
  } catch (err) {
    jsonResponse(res, 500, { error: "Proxy error", message: String(err) });
  }
};
