/**
 * Displayarama Executive Dashboard — CRM Proxy
 * -------------------------------------------------------
 * Vercel Serverless Function. Keeps your Private Integration Token
 * secure on the server — never exposed to the browser.
 *
 * DEPLOY TO VERCEL
 *   1. Push this file as api/CRM.js to your GitHub repo
 *   2. In Vercel Settings -> Environment Variables, add:
 *        GHL_PIT     = pit-e8a6a16c-7d27-4b00-92c4-8437f2ac85af
 *        GHL_LOCATION_ID = ypGka1tD6SCnuZI7heIw
 *   3. Redeploy
 *
 * ENDPOINTS
 *   ?resource=ping            -> location info (test connection)
 *   ?resource=pipelines       -> all pipelines + stages
 *   ?resource=opportunities   -> all opportunities (auto-paginated)
 *   ?resource=users           -> all users
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

// Fetch ALL opportunities using the search endpoint with cursor pagination.
// IMPORTANT: the first page must NOT include startAfter/startAfterId (that
// caused the earlier 422). Cursor params come from the response and are only
// sent on subsequent pages.
async function fetchAllOpportunities(locationId, pit) {
  const all = [];
  const limit = 100;
  let startAfter = "";
  let startAfterId = "";
  let pages = 0;

  while (pages < 100) {
    const query = { location_id: locationId, limit: String(limit) };
    if (startAfter) query.startAfter = startAfter;
    if (startAfterId) query.startAfterId = startAfterId;

    const { ok, status, body } = await ghlFetch(
      "/opportunities/search",
      query,
      pit,
    );

    if (!ok) {
      // First page failure -> surface the real error so we can diagnose.
      if (pages === 0) return { ok: false, status, body };
      break;
    }

    const batch = body.opportunities || [];
    all.push(...batch);

    // Pull next-page cursor from the response. Stop when there's no cursor
    // or we got a short page (end of results).
    const nextAfter = body.startAfter;
    const nextAfterId = body.startAfterId;
    if (!nextAfterId || batch.length < limit) break;

    startAfter = nextAfter;
    startAfterId = nextAfterId;
    pages++;
  }

  return { ok: true, body: { opportunities: all } };
}

module.exports = async (req, res) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    jsonResponse(res, 204, {});
    return;
  }

  const pit = process.env.GHL_PIT;
  const locationId = process.env.GHL_LOCATION_ID;

  // Validate environment variables
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
        const r = await ghlFetch("/users/search", { locationId }, pit);
        jsonResponse(res, r.ok ? 200 : r.status, {
          users: r.body.users || [],
        });
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
