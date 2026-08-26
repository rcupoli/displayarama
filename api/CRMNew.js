/**
 * Displayarama Executive Dashboard — CRM Proxy
 * -------------------------------------------------------
 * Vercel Serverless Function. Keeps your Private Integration Token
 * secure on the server — never exposed to the browser.
 *
 * ENDPOINTS
 *   ?resource=ping            -> location info (test connection)
 *   ?resource=pipelines       -> all pipelines + stages
 *   ?resource=opportunities   -> all opportunities, ENRICHED with contact
 *                                custom fields (estimate amount, decision
 *                                status, reply / response dates) for OPEN
 *                                opportunities only (Won/Lost are skipped to
 *                                stay within serverless time limits).
 *   ?resource=users           -> all location users (single call, no paging)
 *
 * DATA MODEL NOTES
 *  - Deal value = opportunity.monetaryValue (already on every opportunity;
 *    no contact fetch needed for values).
 *  - Reply / user-message dates + decision status live on the CONTACT, not
 *    the opportunity. The opportunity search does not return contact custom
 *    fields, so we fetch each OPEN opportunity's contact by id and merge the
 *    four fields onto the opportunity as a normalized `cf` object. Closed
 *    (won/lost) opportunities get cf=null — they don't need follow-up data.
 */

const BASE = "https://services.leadconnectorhq.com";

// Stable custom-field IDs for this location (contact model).
const CF_ESTIMATE_AMOUNT = "zVxnLvT1OXotdAfoOPxW"; // MONETORY
const CF_DECISION_STATUS = "rjyHxFTkvyeReGBgcMVg"; // TEXT (what lead is waiting on)
const CF_LAST_REPLY_DATE = "zd2J4L69BAe0rF8v0L01"; // DATE
const CF_LAST_USER_MSG_DATE = "uEqftQJaSOVU9msitAkV"; // DATE

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
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    body: json,
  };
}

// Parse a contact custom field value into the shape we need.
function readContactField(customFields, fieldId) {
  const cf = (customFields || []).find((f) => f.id === fieldId);
  if (!cf) return null;
  const v =
    cf.value ?? cf.fieldValueString ?? cf.fieldValueNumber ?? cf.fieldValueDate;
  if (v === undefined || v === null || v === "") return null;
  return v;
}

// DATE field (epoch ms, ISO string, or "YYYY-MM-DD") -> ISO string
function toISO(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
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

// Fetch all location users. The /users/ endpoint returns every user in a
// single call and REJECTS limit/skip params (422), so we do not paginate.
async function fetchAllUsers(locationId, pit) {
  const rList = await ghlFetch("/users/", { locationId }, pit);
  if (!rList.ok || !Array.isArray(rList.body.users)) {
    return { ok: rList.ok, status: rList.status, users: [] };
  }
  return { ok: true, status: 200, users: rList.body.users };
}

// Merge the 4 contact custom fields we need onto a single contact object.
function extractContactFields(contact) {
  const cfs = (contact && contact.customFields) || [];
  return {
    decisionStatus: readContactField(cfs, CF_DECISION_STATUS) || "",
    lastReplyDate: toISO(readContactField(cfs, CF_LAST_REPLY_DATE)),
    lastUserMessageDate: toISO(readContactField(cfs, CF_LAST_USER_MSG_DATE)),
  };
}

// Enrich OPEN opportunities with the four contact custom fields we need.
// Closed (won/lost) opportunities are skipped — they don't need follow-up
// data, and skipping them keeps us well within serverless time limits.
//
// Strategy: the bulk /contacts/search endpoint returns 100 contacts/page in
// ~0.5s and INCLUDES customFields — far faster than fetching contacts
// one-by-one. We paginate it concurrently (several pages in parallel), build
// a contactId -> fields map, and stop as soon as we've covered every open
// opportunity's contactId (or hit the time budget). Any contacts not reached
// in time simply get cf=null.
async function enrichWithContactFields(opportunities, pit, locationId) {
  const open = opportunities.filter(
    (o) => o.status !== "won" && o.status !== "lost",
  );
  const neededIds = new Set(
    open
      .map((o) => o.contactId)
      .filter((id) => id && typeof id === "string"),
  );

  const fieldMap = new Map(); // contactId -> fields

  if (neededIds.size > 0) {
    const PAGE = 100;
    const CONCURRENCY = 12;
    const TIME_BUDGET_MS = 22000;
    const startedAt = Date.now();

    // First request to learn the total page count.
    const first = await ghlFetch(
      "/contacts/search",
      {},
      pit,
      "POST",
      { locationId, pageLimit: PAGE, page: 1 },
    );
    if (first.ok) {
      const firstContacts = first.body.contacts || [];
      for (const c of firstContacts) {
        if (c.id && neededIds.has(c.id)) fieldMap.set(c.id, extractContactFields(c));
      }
      const total = first.body.total || 0;
      const totalPages = Math.min(Math.ceil(total / PAGE) || 1, 400);

      const pageQueue = [];
      for (let p = 2; p <= totalPages; p++) pageQueue.push(p);

      let qi = 0;
      async function pageWorker() {
        while (qi < pageQueue.length) {
          if (fieldMap.size >= neededIds.size) return; // found everyone
          if (Date.now() - startedAt > TIME_BUDGET_MS) return;
          const p = pageQueue[qi++];
          try {
            const r = await ghlFetch(
              "/contacts/search",
              {},
              pit,
              "POST",
              { locationId, pageLimit: PAGE, page: p },
            );
            if (r.ok) {
              for (const c of r.body.contacts || []) {
                if (c.id && neededIds.has(c.id))
                  fieldMap.set(c.id, extractContactFields(c));
              }
            }
          } catch {
            // ignore page failure
          }
        }
      }

      await Promise.all(
        Array.from({ length: CONCURRENCY }, () => pageWorker()),
      );
    }
  }

  return opportunities.map((o) => {
    const cf = (o.contactId && fieldMap.get(o.contactId)) || null;
    return { ...o, cf };
  });
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
        if (!r.ok) {
          jsonResponse(res, r.status, r.body);
          return;
        }
        const opportunities = r.body.opportunities || [];
        const enriched = await enrichWithContactFields(
          opportunities,
          pit,
          locationId,
        );
        jsonResponse(res, 200, { opportunities: enriched });
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
