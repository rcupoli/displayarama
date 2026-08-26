/**
 * Displayarama Executive Dashboard — CRM Proxy
 * -------------------------------------------------------
 * Vercel Serverless Function. Keeps your Private Integration Token
 * secure on the server — never exposed to the browser.
 *
 * ENDPOINTS
 *   ?resource=ping            -> location info (test connection)
 *   ?resource=pipelines       -> all pipelines + stages
 *   ?resource=opportunities   -> all opportunities (page-paginated)
 *   ?resource=users           -> all location users (includes assigned reps)
 *   ?resource=conversations   -> all conversations (inbox threads)
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

  while (page <= 50) {
    const { ok, status, body } = await ghlFetch(
      "/opportunities/search",
      { location_id: locationId, limit: String(limit), page: String(page) },
      pit,
    );

    if (!ok) {
      if (page === 1) return { ok: false, status, body };
      break;
    }

    const batch = body.opportunities || [];
    all.push(...batch);

    if (batch.length < limit) break;
    page++;
  }

  return { ok: true, body: { opportunities: all } };
}

// Fetch ALL conversations (inbox threads) using skip pagination.
// Each conversation carries lastMessageDate + lastMessageDirection
// (inbound = contact replied, outbound = rep replied), which powers the
// Revenue At Risk / unanswered-leads logic.
async function fetchAllConversations(locationId, pit) {
  const all = [];
  const limit = 100;
  let skip = 0;

  while (skip <= 10000) {
    const { ok, status, body } = await ghlFetch(
      "/conversations/search",
      {},
      pit,
      "POST",
      { locationId, limit, skip },
    );

    if (!ok) {
      if (skip === 0) return { ok: false, status, body };
      break;
    }

    const batch = body.conversations || [];
    all.push(...batch);

    if (batch.length < limit) break;
    skip += limit;
  }

  return { ok: true, body: { conversations: all } };
}

// Fetch all location users, including individual lookups for any assignedTo user IDs.
async function fetchAllUsers(locationId, pit, assignedToIds = []) {
  const userMap = new Map();

  // 1. Fetch location user list
  const rList = await ghlFetch("/users/", { locationId }, pit);
  if (rList.ok && Array.isArray(rList.body.users)) {
    rList.body.users.forEach((u) => {
      if (u && u.id) userMap.set(u.id, u);
    });
  }

  // 2. Resolve missing assignedTo user IDs individually
  const missingIds = assignedToIds.filter((id) => id && !userMap.has(id));
  await Promise.all(
    missingIds.map(async (uid) => {
      try {
        const rUser = await ghlFetch(`/users/${uid}`, {}, pit);
        if (rUser.ok) {
          const u = rUser.body.user || rUser.body;
          if (u && u.id) userMap.set(u.id, u);
        }
      } catch {
        // ignore individual user fetch failure
      }
    }),
  );

  return Array.from(userMap.values());
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

      case "conversations": {
        const r = await fetchAllConversations(locationId, pit);
        jsonResponse(res, r.ok ? 200 : r.status, r.body);
        return;
      }

      case "users": {
        // First get opportunities to find assigned user IDs
        const oppsRes = await fetchAllOpportunities(locationId, pit);
        const opps = oppsRes.ok ? oppsRes.body.opportunities || [] : [];
        const assignedIds = Array.from(new Set(opps.map((o) => o.assignedTo).filter(Boolean)));

        const users = await fetchAllUsers(locationId, pit, assignedIds);
        jsonResponse(res, 200, { users });
        return;
      }

      default:
        jsonResponse(res, 404, {
          error: `Unknown resource: ${resource}`,
          validResources: ["ping", "pipelines", "opportunities", "conversations", "users"],
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
