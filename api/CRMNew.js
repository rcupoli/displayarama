/**
 * Displayarama Executive Dashboard — CRM Proxy
 *
 * Vercel Serverless Function. Keeps the Private Integration Token secure on
 * the server — never exposed to the browser.
 *
 * ENDPOINTS
 *   ?resource=ping          -> location info (connection test)
 *   ?resource=pipelines     -> all pipelines + stages
 *   ?resource=opportunities -> all opportunities (page-paginated)
 *   ?resource=users         -> all location users
 *
 * Returns RAW CRM data only — no contact enrichment. This keeps responses
 * well under the serverless time limit. Custom fields ride on each
 * opportunity's customFields array and are read by the frontend mapper.
 */

const BASE = "https://services.leadconnectorhq.com";

function jsonResponse(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.end(JSON.stringify(body));
}

async function ghlFetch(path, query, pit, method = "GET", body) {
  const qs = new URLSearchParams(query).toString();
  const url = `${BASE}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${pit}`,
      Version: "2021-07-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: "Invalid JSON from API", raw: text.slice(0, 500) };
  }
  return { ok: res.status >= 200 && res.status < 300, status: res.status, body: json };
}

// Fetch ALL opportunities using page pagination (limit=100 per page).
async function fetchAllOpportunities(locationId, pit) {
  const all = [];
  const limit = 100;
  let page = 1;
  const MAX_PAGES = 100;

  while (page <= MAX_PAGES) {
    const { ok, status, body } = await ghlFetch(
      "/opportunities/search",
      { location_id: locationId, limit: String(limit), page: String(page) },
      pit,
    );

    if (!ok) {
      if (page === 1) return { ok: false, status, body };
      console.warn(`Opportunity page ${page} failed (${status}), returning ${all.length} results`);
      break;
    }

    const batch = body.opportunities || [];
    all.push(...batch);

    if (batch.length < limit) break;
    page++;
  }

  return { ok: true, body: { opportunities: all } };
}

// Fetch all location users. Single call, no pagination needed.
async function fetchAllUsers(locationId, pit) {
  const rList = await ghlFetch("/users/", { locationId }, pit);
  if (!rList.ok || !Array.isArray(rList.body.users)) {
    return { ok: rList.ok, status: rList.status, users: [] };
  }
  return { ok: true, status: 200, users: rList.body.users };
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    jsonResponse(res, 204, {});
    return;
  }

  const pit = process.env.GHL_PIT;
  const locationId = process.env.GHL_LOCATION_ID;

  if (!pit || !locationId) {
    jsonResponse(res, 500, {
      error: "Server missing GHL_PIT or GHL_LOCATION_ID environment variables.",
      hint: "Add them in Vercel Project Settings -> Environment Variables, then redeploy.",
    });
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const resource = url.searchParams.get("resource") || "ping";

  try {
    switch (resource) {
      case "ping": {
        const r = await ghlFetch(`/locations/${locationId}`, {}, pit);
        jsonResponse(res, r.ok ? 200 : r.status, {
          ok: r.ok,
          locationId,
          location: r.body,
        });
        return;
      }

      case "pipelines": {
        const r = await ghlFetch("/opportunities/pipelines", { locationId }, pit);
        jsonResponse(res, r.ok ? 200 : r.status, r.body);
        return;
      }

      case "opportunities": {
        const r = await fetchAllOpportunities(locationId, pit);
        jsonResponse(res, r.ok ? 200 : r.status, r.body);
        return;
      }

      case "users": {
        const r = await fetchAllUsers(locationId, pit);
        jsonResponse(res, r.ok ? 200 : r.status, { users: r.users });
        return;
      }

      default:
        jsonResponse(res, 404, {
          error: `Unknown resource: ${resource}`,
          validResources: ["ping", "pipelines", "opportunities", "users"],
        });
    }
  } catch (err) {
    console.error("Proxy error:", err);
    jsonResponse(res, 500, {
      error: "Proxy internal error",
      message: String(err).slice(0, 200),
    });
  }
};
