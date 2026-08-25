/**
 * Displayarama Executive Dashboard — CRM Proxy
 * Vercel Serverless Function. Keeps your Private Integration Token
 * secure on the server — never exposed to the browser.
 *
 * DEPLOY TO VERCEL
 *   1. Push this file as api/CRM.js to your GitHub repo
 *   2. In Vercel Settings -> Environment Variables, add:
 *        GHL_PIT         = pit-e8a6a16c-7d27-4b00-92c4-8437f2ac85af
 *        GHL_LOCATION_ID = ypGka1tD6SCnuZI7heIw
 *   3. Redeploy
 *
 * ENDPOINTS
 *   ?resource=ping          -> location info (test connection)
 *   ?resource=pipelines     -> all pipelines + stages
 *   ?resource=opportunities -> all opportunities (auto-paginated)
 *   ?resource=users         -> all users
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

async function ghlFetch(path, query, pit) {
  const qs = new URLSearchParams(query).toString();
  const url = `${BASE}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${pit}`,
      Version: "2021-07-28",
    },
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

// Fetch ALL opportunities using skip/limit pagination.
async function fetchAllOpportunities(locationId, pit) {
  const all = [];
  let skip = 0;
  const limit = 100;

  while (skip < 10000) {
    const { ok, status, body } = await ghlFetch(
      "/opportunities/",
      { location_id: locationId, limit: String(limit), skip: String(skip) },
      pit,
    );

    if (!ok) {
      if (skip === 0) return { ok: false, status, body };
      break;
    }

    const batch = body.opportunities || [];
    all.push(...batch);
    if (batch.length < limit) break;
    skip += limit;
  }

  return { ok: true, body: { opportunities: all } };
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
