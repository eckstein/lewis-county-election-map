// Proxy for the results.votewa.gov JSON feeds the map reads. The upstream
// cache sometimes serves responses without Access-Control-Allow-Origin, so
// browsers block them; this Worker fetches server-side, where CORS doesn't
// apply, and always returns the header. Only the map's feed paths are allowed,
// so it can't be used as an open proxy.

const UPSTREAM = "https://results.votewa.gov/results/public/api/elections";

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

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return reply(null, 204);
    if (request.method !== "GET") return reply("Method not allowed", 405);

    const { pathname } = new URL(request.url);
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
