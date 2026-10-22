// Proxy for the results.votewa.gov JSON feeds the map reads. The upstream
// cache sometimes serves responses without Access-Control-Allow-Origin, so
// browsers block them; this Worker fetches server-side, where CORS doesn't
// apply, and always returns the header. Only the map's feed paths are allowed,
// so it can't be used as an open proxy.
//
// /geocode?address=... passes an address to the U.S. Census Bureau geocoder
// (which sends no CORS header) for the map's "find my precinct" search. It is
// never cached or logged.
//
// /returns/<election id> downloads the Secretary of State's daily ballot status
// report (matchback) for that election and returns only totals: by precinct,
// by received date, by return method and by drop box. The file lists
// individual voters, so nothing voter-level is ever sent on. This is the same
// totaling scripts/build.py does, so the map picks up the state's ~5 p.m. file
// within minutes instead of waiting for the hourly GitHub build.

const UPSTREAM = "https://results.votewa.gov/results/public/api/elections";
const GEOCODER = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

// The matchback URL always holds the current election, so each entry names the
// Election column value it must carry. Move this to the next election's id
// along with the matchback keys in scripts/build.py.
const MATCHBACK = {
  "20261103": {
    url: "https://www.sos.wa.gov/sites/default/files/current_election/Lewis.csv",
    election: "General Nov 3 2026",
  },
};
const RETURNS_TTL = 300;  // seconds to reuse a total before checking the state again

// Matchback statuses that mean the ballot has not come back yet.
const NOT_RETURNED = new Set(["", "issued", "sent", "mailed", "undeliverable", "not returned", "none"]);
const LEWIS_CODES = new Set(["LE", "LEWIS", "53041", "041", "21"]);

const ALLOWED = [
  /^\/(lewis-county-wa|washington)\/\d{8}\/data$/,
  /^\/lewis-county-wa\/\d{8}\/data\/ballot-item\/[0-9a-f-]{36}$/i,
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function reply(body, status, extra = {}) {
  return new Response(body, { status, headers: { ...CORS, ...extra } });
}

// Returns {matches: [{address, lng, lat}]} for a one-line address.
async function geocode(address) {
  const noStore = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  address = (address || "").trim();
  if (address.length < 5 || address.length > 200) return reply('{"error":"bad address"}', 400, noStore);

  const url = `${GEOCODER}?${new URLSearchParams({ address, benchmark: "Public_AR_Current", format: "json" })}`;
  let data;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return reply(`{"error":"geocoder returned ${res.status}"}`, 502, noStore);
    data = await res.json();
  } catch (err) {
    return reply('{"error":"geocoder unreachable"}', 502, noStore);
  }
  const matches = (data?.result?.addressMatches || []).slice(0, 5).map((m) => ({
    address: m.matchedAddress,
    lng: m.coordinates.x,
    lat: m.coordinates.y,
  }));
  return reply(JSON.stringify({ matches }), 200, noStore);
}

const norm = (s) => String(s ?? "").toUpperCase().split(/\s+/).filter(Boolean).join(" ");

// Minimal CSV reader: quoted fields, doubled quotes, CRLF or LF line ends.
function* csvRows(text, delim) {
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      yield row; row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); yield row; }
}

function findCol(header, needles, avoid = []) {
  const lowered = header.map((h) => h.toLowerCase().replace(/[_ ]/g, ""));
  for (const needle of needles) {
    const i = lowered.findIndex((h) => h.includes(needle) && !avoid.some((a) => h.includes(a)));
    if (i >= 0) return i;
  }
  return null;
}

// "10/20/2026", "2026-10-20" or "10/20/26", with or without a time -> "2026-10-20".
function isoDate(value) {
  const v = (value || "").trim().split(" ")[0].split("T")[0];
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

const bump = (obj, key, n = 1) => { obj[key] = (obj[key] || 0) + n; };
const sortedDesc = (obj) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]));

// Totals in the same shape as the "returns" block scripts/build.py writes. Precincts
// are keyed by the file's own precinct value (normalized); the page matches them
// to the map by name, number or state code.
function totalMatchback(text, fileTime) {
  text = text.replace(/^\uFEFF/, "");
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delim = ["|", ",", "\t"].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best);
  const rows = csvRows(text, delim);
  const header = rows.next().value || [];
  const col = {
    county: findCol(header, ["countycode", "county"]),
    precinct: findCol(header, ["precinctname", "precinctcode", "precinct"], ["split"]),
    status: findCol(header, ["ballotstatus", "status"], ["voterstatus", "registration"]),
    date: findCol(header, ["receiveddate", "datereceived", "received"]),
    method: findCol(header, ["returnmethod"]),
    location: findCol(header, ["returnlocation"]),
    election: findCol(header, ["election"]),
  };
  if (col.precinct == null) throw new Error("no precinct column");
  const cell = (row, i) => (i != null && row.length > i ? row[i].trim() : null);

  const precincts = {}, statusCounts = {}, daily = {}, methods = {}, locations = {};
  let election = null;
  for (const row of rows) {
    if (row.length === 1 && row[0] === "") continue;  // blank line
    election ??= cell(row, col.election);
    const county = cell(row, col.county);
    if (county != null && !LEWIS_CODES.has(county.toUpperCase())) continue;
    const status = cell(row, col.status) ?? "Received";
    bump(statusCounts, status);
    if (NOT_RETURNED.has(status.toLowerCase())) continue;
    const key = norm(cell(row, col.precinct) ?? "");
    const bucket = (precincts[key] ||= {});
    bump(bucket, "returned");
    const s = status.toLowerCase();
    if (s.includes("accept")) bump(bucket, "accepted");
    else if (s.includes("challeng") || s.includes("reject") || s.includes("cure")) bump(bucket, "challenged");
    const d = isoDate(cell(row, col.date));
    if (d) bump(daily, d);
    const method = cell(row, col.method);
    if (method != null) bump(methods, method || "Unknown");
    const location = cell(row, col.location);
    if (location) bump(locations, location.split(/\s+/).join(" "));
  }

  const sum = (k) => Object.values(precincts).reduce((n, p) => n + (p[k] || 0), 0);
  return {
    election,
    returns: {
      available: true,
      source: "live",
      fileTime,
      returned: sum("returned"),
      accepted: sum("accepted"),
      challenged: sum("challenged"),
      statusCounts,
      daily: Object.entries(daily).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
      methods: sortedDesc(methods),
      locations: sortedDesc(locations),
    },
    precincts,
  };
}

async function returns(id, ctx) {
  const json = { "Content-Type": "application/json; charset=utf-8" };
  const config = MATCHBACK[id];
  if (!config) return reply('{"error":"no live returns for this election"}', 404, json);

  // Totaling the file takes a moment, so keep each result for RETURNS_TTL.
  const cache = caches.default;
  const cacheKey = new Request(`https://returns.cache/${id}`);
  const hit = await cache.match(cacheKey);
  if (hit) return reply(hit.body, 200, { ...json, "Cache-Control": `public, max-age=60` });

  let upstream;
  try {
    upstream = await fetch(config.url, {
      headers: { "User-Agent": "lewis-county-election-map (github.com/eckstein/lewis-county-election-map)" },
      cf: { cacheTtl: 0 },
    });
  } catch (err) {
    return reply(`{"error":"state site unreachable"}`, 502, { ...json, "Cache-Control": "no-store" });
  }
  const text = await upstream.text();
  if (!upstream.ok || !text.slice(0, 4096).includes("Election")) {
    // A bot check page or an error, not the CSV.
    return reply(`{"error":"state returned ${upstream.status}, not the expected file"}`, 502,
      { ...json, "Cache-Control": "no-store" });
  }

  let totals;
  try {
    const modified = upstream.headers.get("Last-Modified");
    totals = totalMatchback(text, modified ? new Date(modified).toISOString() : null);
  } catch (err) {
    return reply(`{"error":"couldn't read the state file: ${err.message}"}`, 502, { ...json, "Cache-Control": "no-store" });
  }
  if (norm(totals.election) !== norm(config.election)) {
    return reply(JSON.stringify({ error: `state file is for '${totals.election}', not '${config.election}'` }), 409,
      { ...json, "Cache-Control": "no-store" });
  }
  delete totals.election;

  const body = JSON.stringify(totals);
  ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers: { ...json, "Cache-Control": `max-age=${RETURNS_TTL}` } })));
  return reply(body, 200, { ...json, "Cache-Control": "public, max-age=60" });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return reply(null, 204);
    if (request.method !== "GET") return reply("Method not allowed", 405);

    const { pathname, searchParams } = new URL(request.url);
    if (pathname === "/geocode") return geocode(searchParams.get("address"));
    const returnsPath = pathname.match(/^\/returns\/(\d{8})$/);
    if (returnsPath) return returns(returnsPath[1], ctx);
    if (!ALLOWED.some((re) => re.test(pathname))) return reply("Not found", 404);

    let upstream;
    try {
      upstream = await fetch(UPSTREAM + pathname, {
        headers: {
          Accept: "application/json",
          "User-Agent": "lewis-county-election-map (github.com/eckstein/lewis-county-election-map)",
        },
      });
    } catch (err) {
      return reply(`Upstream unreachable: ${err}`, 502);
    }

    const type = upstream.headers.get("Content-Type") || "";
    if (!upstream.ok || !type.includes("json")) {
      return reply(`Upstream returned ${upstream.status} ${type}`, upstream.ok ? 502 : upstream.status, {
        "Cache-Control": "no-store",
      });
    }
    return reply(upstream.body, 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=30",
    });
  },
};
