// Lewis County election map: precinct choropleth of ballots received and
// contest results.
//
// Results come live from the county's results.votewa.gov feed: the summary
// every LIVE_MS, and precinct results for the contest being viewed. Ballot-return
// totals for the current election come from the Worker's /returns route, which
// totals the state's daily file as soon as it's posted. site/data/ (written by
// scripts/build.py) holds the boundaries, the last committed ballot-return
// totals, and a results snapshot used when the live feeds can't be reached.

// Feed requests go through our Cloudflare Worker (worker/) first, which always
// adds the CORS header; the feed itself is the fallback. Empty skips the Worker.
const PROXY = "https://lc-results-proxy.zacharyeckstein.workers.dev";
const FEED = "https://results.votewa.gov/results/public/api/elections";
const COUNTY = "lewis-county-wa";
// Totals for contests that extend beyond the county (statewide measures and
// races, legislative and congressional districts) come from the state feed.
const STATE = "washington";
const LIVE_MS = 60 * 1000;
const STATIC_MS = 5 * 60 * 1000;
const SEQ = ["#dbe8f4", "#a8c8e4", "#6fa3d0", "#3a7bb8", "#15508e"];
const OPTION_COLORS = ["#2d6fb5", "#c4572a", "#3a8a55", "#7a4fb8", "#b48a1c", "#2b8a8a", "#a8326e", "#5d6b78"];
const PARTY_COLORS = { DEM: "#2d6fb5", REP: "#c43b3b" };
const NO_DATA = "#d9d9d4";

const fmt = new Intl.NumberFormat("en-US");
const pct = (n, d) => (d > 0 ? (100 * n) / d : null);
const pctText = (v) => (v == null ? "–" : `${v.toFixed(1)}%`);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const norm = (s) => String(s ?? "").toUpperCase().split(/\s+/).filter(Boolean).join(" ");
const en = (list) => (list || []).find((t) => t.languageId === "en")?.text ?? list?.[0]?.text ?? "";
const when = (t) => t ? new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "–";

const state = {
  elections: [],
  electionId: null,
  data: null,
  layerName: null,
  userPickedLayer: false,
  contestId: null,
  selected: null,
  geoLayer: null,
  live: null,          // true/false after the first live check
  liveCheckedAt: null,
  wide: new Map(),     // parent contest id -> totals across every county it covers
  precinctKey: null,   // matchback precinct value -> map precinct name
  noLiveReturns: new Set(),  // elections the Worker has no /returns for
};

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ map setup

const map = L.map("map", { zoomSnap: 0.25 }).setView([46.58, -122.4], 9);
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas";
L.tileLayer(`${ESRI}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
  attribution: "Basemap &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors",
  maxZoom: 16,
}).addTo(map);
// Place labels drawn above the precinct fills.
map.createPane("labels").style.zIndex = 450;
map.getPane("labels").style.pointerEvents = "none";
L.tileLayer(`${ESRI}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { pane: "labels", maxZoom: 16 }).addTo(map);

const legend = L.control({ position: "bottomright" });
legend.onAdd = () => L.DomUtil.create("div", "legend");
legend.addTo(map);

// Share and Table float in the map's top-right corner.
const mapActions = L.control({ position: "topright" });
mapActions.onAdd = () => {
  const el = L.DomUtil.create("div", "map-actions");
  el.innerHTML = `<button id="share" type="button">🔗 Share this view</button>` +
    `<button id="open-table" type="button" aria-haspopup="dialog">▦ Table</button>`;
  L.DomEvent.disableClickPropagation(el);
  L.DomEvent.disableScrollPropagation(el);
  return el;
};
mapActions.addTo(map);

// --------------------------------------------------------------- data access

async function getJSON(url, bust = true) {
  const res = await fetch(bust ? `${url}?t=${Date.now()}` : url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

// The results.votewa.gov cache sometimes serves copies without the
// Access-Control-Allow-Origin header (about a third of requests in testing,
// whatever the query string), and the browser then blocks the response. The
// Worker avoids that; going direct, each attempt is independent, so retry a few
// times before giving up.
async function getFeed(path, attempts = 5) {
  if (PROXY) {
    try {
      return await getJSON(`${PROXY}/${path}`, false);
    } catch (err) {
      console.warn("proxy failed; trying the feed directly", err);
    }
  }
  for (let i = 1; ; i++) {
    try {
      return await getJSON(`${FEED}/${path}`, false);
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 400 * i));
    }
  }
}

function precinct(name) {
  return state.data?.precincts[name] || {};
}

function contest() {
  const contests = state.data?.contests || [];
  return contests.find((c) => c.id === state.contestId) || contests[0];
}

// Ballot measures (Yes/No, Approved/Rejected, Levy Yes/Levy No, ...) get a
// diverging scale instead of leader colors: teal for yes, orange for no,
// darker further from 50/50. Bins are the yes share's upper bounds.
const MEASURE_BINS = [
  [0.35, "#b4541f", "no", "65%+"],
  [0.45, "#dd8a52", "no", "55–65%"],
  [0.50, "#f3c9a6", "no", "50–55%"],
  [0.55, "#a8dcd6", "yes", "50–55%"],
  [0.65, "#4fa8a0", "yes", "55–65%"],
  [1.01, "#1b6f69", "yes", "65%+"],
];

// Index of the "yes" option for a two-option measure, or -1.
function yesIndex(c) {
  if (c?.type !== "BallotMeasure" || c.options.length !== 2) return -1;
  const yes = /\b(yes|approved?|for|maintained)\b/i;
  const no = /\b(no|rejected?|against|repealed)\b/i;
  const [a, b] = c.options.map((o) => o.name);
  if (yes.test(a) && no.test(b)) return 0;
  if (no.test(a) && yes.test(b)) return 1;
  return -1;
}

// Colors go to options in order of countywide votes so the front-runners always
// get distinct hues; each party's top vote-getter gets the party color.
function optionColors(c) {
  if (c._colors) return c._colors;
  const yi = yesIndex(c);
  if (yi >= 0) {
    c._colors = yi === 0 ? [MEASURE_BINS[5][1], MEASURE_BINS[0][1]] : [MEASURE_BINS[0][1], MEASURE_BINS[5][1]];
    return c._colors;
  }
  const rank = c.options.map((_, i) => i).sort((a, b) => c.options[b].votes - c.options[a].votes);
  const free = OPTION_COLORS.filter((col) => !Object.values(PARTY_COLORS).includes(col));
  const usedParties = new Set();
  const colors = [];
  rank.forEach((i) => {
    const party = c.options[i].party;
    if (PARTY_COLORS[party] && !usedParties.has(party)) {
      usedParties.add(party);
      colors[i] = PARTY_COLORS[party];
    } else {
      colors[i] = free.shift() || "#8a8f96";
    }
  });
  c._colors = colors;
  return colors;
}

// ------------------------------------------------------------- live results

// Merge the county feed's summary into state.data. Precinct results for a
// contest are kept until fresh ones load, so the map doesn't flash gray.
async function fetchLive() {
  const id = state.electionId;
  const feed = await getFeed(`${COUNTY}/${id}/data`);
  if (id !== state.electionId) return;
  const d = state.data;
  const el = feed.election;
  const changed = el.lastUpdated !== d.results.lastUpdated || !state.live;

  for (const row of feed.voterTurnout || []) {
    const p = (d.precincts[norm(row.precinctName)] ||= {});
    p.registered = row.voterRegistration || 0;
    p.counted = row.ballotsCast || 0;
  }
  Object.assign(d.results, {
    asOf: el.asOf,
    lastUpdated: el.lastUpdated,
    official: !!el.isOfficialResults,
    hasPrecinctResults: !!el.includePrecinctResults,
    ballotsCast: el.ballotsCast || 0,
    registered: (feed.voterTurnout || []).reduce((sum, r) => sum + (r.voterRegistration || 0), 0),
  });

  const previous = new Map(d.contests.map((c) => [c.id, c]));
  d.contests = (feed.ballotItems || []).map((item) => {
    const old = previous.get(item.id);
    const options = item.summaryResults.ballotOptions;
    return {
      id: item.id,
      name: en(item.name),
      type: item.contestType,
      total: item.voteTotal || 0,
      options: options.map((o) => ({ name: en(o.name), party: o.party?.abbreviation, votes: o.voteCount || 0 })),
      optionIds: options.map((o) => o.id),
      parentId: item.parentId,
      counties: (item.crossCounties || []).length,
      precincts: old?.precincts || {},
      loaded: !changed && !!old?.loaded,
    };
  });

  if (d.contests.some((c) => c.parentId && c.counties > 1)) {
    try {
      await fetchWide(id);
    } catch (err) {
      console.warn("statewide totals failed; keeping last ones", err);
    }
  }
}

// Totals across all counties for each multi-county contest, keyed by the
// statewide contest id that county contests point to with parentId.
async function fetchWide(id) {
  const feed = await getFeed(`${STATE}/${id}/data`);
  if (id !== state.electionId) return;
  for (const item of feed.ballotItems || []) {
    state.wide.set(item.id, {
      total: item.voteTotal || 0,
      votes: new Map(item.summaryResults.ballotOptions.map((o) => [norm(en(o.name)), o.voteCount || 0])),
      lastUpdated: feed.election.lastUpdated,
    });
  }
}

// The wider race's votes lined up with this contest's options, or null when the
// contest is county-only or the state totals haven't loaded.
function wideFor(c) {
  const wide = c.parentId && c.counties > 1 && state.wide.get(c.parentId);
  if (!wide) return null;
  const statewide = c.counties >= 39;
  return {
    label: statewide ? "Statewide" : `Whole district (${c.counties} counties)`,
    tag: statewide ? "State" : "District",
    total: wide.total,
    votes: c.options.map((o) => wide.votes.get(norm(o.name)) || 0),
  };
}

async function loadBreakdown() {
  const c = contest();
  if (!c || c.loaded || c.loading || !state.live || !state.data.results.hasPrecinctResults) return;
  c.loading = true;
  try {
    const detail = await getFeed(`${COUNTY}/${state.electionId}/data/ballot-item/${c.id}`);
    const precincts = {};
    for (const row of detail.ballotItemWithBreakdown?.breakdownResults || []) {
      const votes = new Map(row.ballotOptions.map((o) => [o.id, o.voteCount || 0]));
      precincts[norm(en(row.precinct.name))] = c.optionIds.map((i) => votes.get(i) || 0);
    }
    c.precincts = precincts;
    c.loaded = true;
    if (c === contest()) renderAll();
  } catch (err) {
    console.warn("precinct results failed", err);
  } finally {
    c.loading = false;
  }
}

async function refreshLive() {
  try {
    await fetchLive();
    state.live = true;
  } catch (err) {
    console.warn("live results failed; showing snapshot", err);
    state.live = false;
  }
  state.liveCheckedAt = new Date();
  if (!state.userPickedLayer) state.layerName = defaultLayer(state.data);
  const posted = state.data.results.lastUpdated;
  const isNew = state.live && state.lastSeenUpdate && posted !== state.lastSeenUpdate;
  if (state.live) state.lastSeenUpdate = posted;
  renderAll();
  loadBreakdown();
  if (isNew) announceNewResults();
}

// ------------------------------------------------------- new results cue

// The county posts counts in batches on election night. When a batch lands
// while the page is open, mark it: a "New results" banner, a flash on the
// totals, and a dot in the tab title if the page is in the background.
const BASE_TITLE = document.title;

function renderUpdated() {
  const d = state.data;
  const el = $("updated");
  el.hidden = !d.results.ballotsCast;
  if (el.hidden) return;
  const time = new Date(d.results.lastUpdated).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const day = new Date(d.results.lastUpdated).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  el.classList.toggle("new", !!state.newResults);
  el.textContent = state.newResults
    ? `New results posted at ${time}`
    : d.results.official ? `Final results, certified` : `Latest county count: ${day}, ${time}`;
}

function announceNewResults() {
  state.newResults = true;
  renderUpdated();
  const summary = $("summary");
  summary.classList.remove("flash");
  void summary.offsetWidth;  // restart the animation
  summary.classList.add("flash");
  if (document.hidden) document.title = `● New results · ${BASE_TITLE}`;
  // Back to the plain timestamp after a few minutes.
  clearTimeout(announceNewResults.timer);
  announceNewResults.timer = setTimeout(() => { state.newResults = false; renderUpdated(); }, 5 * 60 * 1000);
}

document.addEventListener("visibilitychange", () => { if (!document.hidden) document.title = BASE_TITLE; });

// Ballot-return totals change once a day, when the state posts its file. Totals
// never go back to an older file, whichever source they came from.
function applyReturns(returns, byName) {
  const d = state.data;
  if (d.returns.available && returns.fileTime && d.returns.fileTime && new Date(returns.fileTime) <= new Date(d.returns.fileTime)) {
    return false;
  }
  d.returns = returns;
  for (const name of new Set([...Object.keys(d.precincts), ...Object.keys(byName)])) {
    const p = byName[name] || {};
    const target = (d.precincts[name] ||= {});
    for (const key of ["returned", "accepted", "challenged"]) target[key] = p[key] || 0;
  }
  return true;
}

// The Worker keys precincts by the state file's own value, which can be the
// precinct's name, number or state code, as scripts/build.py matches them.
function precinctKeys(geo) {
  const byName = {}, byNum = {}, byCode = {};
  for (const { properties: p } of geo.features) {
    byName[p.name] = p.name;
    byNum[String(p.num)] = p.name;
    byCode[String(p.code).toUpperCase()] = p.name;
  }
  return (key) => byName[key] || byCode[key] || byNum[key.replace(/^0+/, "") || "0"];
}

async function refreshLiveReturns() {
  const id = state.electionId;
  if (!PROXY || state.noLiveReturns.has(id)) return false;
  const res = await fetch(`${PROXY}/returns/${id}`);
  if (res.status === 404) { state.noLiveReturns.add(id); return false; }
  if (!res.ok) throw new Error(`live returns: ${res.status} ${await res.text()}`);
  const fresh = await res.json();
  if (state.electionId !== id) return false;
  const byName = {};
  let unmatched = 0;
  for (const [key, p] of Object.entries(fresh.precincts)) {
    const name = state.precinctKey(key);
    if (!name) { unmatched += p.returned || 0; continue; }
    const target = (byName[name] ||= {});
    for (const [k, n] of Object.entries(p)) target[k] = (target[k] || 0) + n;
  }
  if (unmatched) console.warn(`${unmatched} returned ballots had unmatched precincts`);
  return applyReturns({ ...fresh.returns, unmatched }, byName);
}

async function refreshStatic() {
  const id = state.electionId;
  let changed = false;
  try {
    changed = await refreshLiveReturns();
  } catch (err) {
    console.warn("live returns failed; using the published totals", err);
  }
  try {
    const fresh = await getJSON(`data/${id}.json`);
    if (fresh.id === state.electionId && fresh.generatedAt !== state.data.generatedAt) {
      state.data.generatedAt = fresh.generatedAt;
      if (fresh.returns.available) changed = applyReturns(fresh.returns, fresh.precincts) || changed;
    }
  } catch (err) {
    console.warn("returns refresh failed", err);
  }
  if (changed && state.electionId === id) renderAll();
}

// ------------------------------------------------------------------- styling

// Returned layer: share of registered voters, binned on a scale that stretches
// to the current maximum so early returns (5-20%) still show contrast.
function rateFor(name) {
  const p = precinct(name);
  if (p.returned == null || !p.registered) return null;
  return pct(p.returned, p.registered);
}

function rateBreaks() {
  const rates = Object.keys(state.data.precincts).map(rateFor).filter((v) => v != null && v > 0);
  const max = rates.length ? Math.max(...rates) : 100;
  const step = [2, 5, 10, 20].find((s) => s * SEQ.length >= max) ?? 20;
  return SEQ.map((_, i) => step * (i + 1));
}

function leaderFor(name) {
  const c = contest();
  const votes = c?.precincts[name];
  if (!votes) return null;
  const total = votes.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let lead = 0;
  votes.forEach((v, i) => { if (v > votes[lead]) lead = i; });
  const tied = votes.filter((v) => v === votes[lead]).length > 1;
  return { idx: lead, share: votes[lead] / total, total, tied };
}

function styleFor(feature) {
  const name = feature.properties.name;
  const sel = name === state.selected;
  const base = { weight: sel ? 3 : 0.7, color: sel ? "#111" : "#55595e", opacity: sel ? 1 : 0.6, fillOpacity: 0.85 };

  if (state.layerName === "results") {
    const lead = leaderFor(name);
    if (!lead) return { ...base, fillColor: NO_DATA };
    const yi = yesIndex(contest());
    if (yi >= 0) {
      const votes = contest().precincts[name];
      const yesShare = votes[yi] / lead.total;
      return { ...base, fillColor: MEASURE_BINS.find(([max]) => yesShare < max)[1], fillOpacity: 0.9 };
    }
    if (lead.tied) return { ...base, fillColor: "#9a9a96" };
    const colors = optionColors(contest());
    // Darker = bigger lead. 30% share or less is lightest, 80%+ is solid.
    const strength = Math.max(0, Math.min(1, (lead.share - 0.3) / 0.5));
    return { ...base, fillColor: colors[lead.idx], fillOpacity: 0.3 + 0.65 * strength };
  }

  const rate = rateFor(name);
  if (rate == null) return { ...base, fillColor: NO_DATA };
  const breaks = state.breaks;
  const bin = breaks.findIndex((b) => rate <= b);
  return { ...base, fillColor: SEQ[bin === -1 ? SEQ.length - 1 : bin] };
}

function restyle() {
  if (state.layerName !== "results") state.breaks = rateBreaks();
  state.geoLayer?.setStyle(styleFor);
  state.geoLayer?.eachLayer((l) => { if (l.feature.properties.name === state.selected) l.bringToFront(); });
  renderLegend();
}

// ----------------------------------------------------------------- rendering

function renderLegend() {
  const el = legend.getContainer();
  if (state.layerName === "results") {
    const c = contest();
    if (!c) { el.innerHTML = ""; return; }
    const yi = yesIndex(c);
    if (yi >= 0) {
      const names = { yes: c.options[yi].name, no: c.options[1 - yi].name };
      el.innerHTML = `<b>Winning side by precinct</b>` +
        [...MEASURE_BINS].reverse().map(([, color, side, range]) =>
          `<div><i style="background:${color}"></i>${esc(names[side])} ${range}</div>`).join("") +
        `<div><i style="background:${NO_DATA}"></i>No results for this precinct</div>`;
      return;
    }
    const colors = optionColors(c);
    const leaders = new Set(Object.keys(c.precincts).map((n) => leaderFor(n)?.idx));
    const shown = c.options.map((o, i) => [o, i]).filter(([, i]) => leaders.has(i) || !Object.keys(c.precincts).length);
    el.innerHTML = `<b>Leader by precinct</b>` +
      shown.map(([o, i]) => `<div><i style="background:${colors[i]}"></i>${esc(o.name)}</div>`).join("") +
      `<div class="muted" style="margin-top:4px">Darker = larger lead</div>` +
      `<div><i style="background:${NO_DATA}"></i>No results for this precinct</div>`;
    return;
  }
  let lo = 0;
  el.innerHTML = `<b>Ballots received, % of registered voters</b>` +
    state.breaks.map((b, i) => {
      const row = `<div><i style="background:${SEQ[i]}"></i>${Math.round(lo)}–${Math.round(b)}%</div>`;
      lo = b;
      return row;
    }).join("") +
    `<div><i style="background:${NO_DATA}"></i>No data</div>`;
}

function bars(options, votes, colors) {
  const total = votes.reduce((a, b) => a + b, 0);
  return `<ul class="bars">` + options.map((o, i) => {
    const share = total ? (100 * votes[i]) / total : 0;
    return `<li><div class="row"><span class="name"><span class="swatch" style="background:${colors[i]}"></span>${esc(o.name)}${o.party ? ` <span class="muted">${esc(o.party)}</span>` : ""}</span>` +
      `<span class="num">${fmt.format(votes[i])} · ${share.toFixed(1)}%</span></div>` +
      `<div class="track"><div class="fill" style="width:${share}%;background:${colors[i]}"></div></div></li>`;
  }).join("") + `</ul>`;
}

// Each option gets two bars: its share in Lewis County and in the whole race.
function compareBars(options, local, wide, colors) {
  const sum = (v) => v.reduce((a, b) => a + b, 0);
  const localTotal = sum(local);
  const wideTotal = sum(wide.votes);
  const bar = (tag, votes, total, color, cls) => {
    const share = total ? (100 * votes) / total : 0;
    return `<div class="pair ${cls}" title="${fmt.format(votes)} votes"><span class="tag">${tag}</span>` +
      `<div class="track"><div class="fill" style="width:${share}%;background:${color}"></div></div>` +
      `<span class="num">${share.toFixed(1)}%</span></div>`;
  };
  return `<div class="compare-key"><span><i class="k-local"></i>Lewis County</span><span><i class="k-wide"></i>${esc(wide.label)}</span></div>` +
    `<ul class="bars compare">` + options.map((o, i) =>
      `<li><div class="row"><span class="name"><span class="swatch" style="background:${colors[i]}"></span>${esc(o.name)}${o.party ? ` <span class="muted">${esc(o.party)}</span>` : ""}</span></div>` +
      bar("Lewis", local[i], localTotal, colors[i], "local") +
      bar(wide.tag, wide.votes[i], wideTotal, colors[i], "wide") + `</li>`).join("") + `</ul>` +
    `<p class="muted compare-totals">Votes: ${fmt.format(localTotal)} in Lewis · ${fmt.format(wideTotal)} ${wide.tag === "State" ? "statewide" : "districtwide"}</p>`;
}

// Where ballots stand, in a sentence and a bar: counted, received but not yet
// counted, and not returned. Received comes from the state's daily file and
// counted from the live feed, so on election night counted can briefly run
// ahead of received; the sentence then just reports the count.
function ballotProgress({ registered, received, counted, challenged }, place, brief = false) {
  const d = state.data;
  const hasReceived = d.returns.available && received != null;
  const counting = d.results.ballotsCast > 0;
  const ofVoters = `of the ${fmt.format(registered)} registered voters in ${place}`;
  const later = d.results.official ? "These results are final." : "The county will post more results in the coming days.";
  let lead, follow;
  if (!counting) {
    lead = hasReceived
      ? `<b>${fmt.format(received)} ballots received</b> — ${pctText(pct(received, registered))} ${ofVoters}.`
      : `<b>${fmt.format(registered)} registered voters</b> in ${place}.`;
    follow = `Counting begins at ${releaseTime(d.id)}.`;
  } else if (hasReceived && received > counted) {
    lead = `<b>${fmt.format(counted)} of ${fmt.format(received)} ballots counted</b> — ${fmt.format(received - counted)} received ballots are still being processed.`;
    follow = later;
  } else {
    lead = `<b>${fmt.format(counted)} ballots counted</b> — ${pctText(pct(counted, registered))} ${ofVoters}.`;
    follow = later;
  }

  const countedShare = counting ? Math.min(100, pct(counted, registered) || 0) : 0;
  const receivedShare = hasReceived ? Math.max(0, Math.min(100 - countedShare, pct(received - (counting ? counted : 0), registered) || 0)) : 0;
  const key = [
    counting && `<span><i class="seg-counted"></i>Counted</span>`,
    hasReceived && `<span><i class="seg-received"></i>${counting ? "Received, not yet counted" : "Received"}</span>`,
    `<span><i class="seg-rest"></i>${d.results.official ? "Didn't vote" : "Not returned yet"}</span>`,
  ].filter(Boolean).join("");

  return `<p class="progress-text">${lead}${brief ? "" : `<br><span class="muted">${follow}</span>`}</p>` +
    `<div class="progress" aria-hidden="true"><div class="seg-counted" style="width:${countedShare}%"></div>` +
    `<div class="seg-received" style="width:${receivedShare}%"></div></div>` +
    `<div class="progress-key">${key}</div>` +
    (hasReceived && challenged ? `<p class="challenged">Challenged: <b>${fmt.format(challenged)}</b></p>` : "");
}

// Columns of ballots received per day (by the date the county received them).
// Days with none are filled in so the dates stay evenly spaced; the latest day
// is labeled and every column has a hover tooltip.
function receivedChart(daily) {
  if (!daily?.length) return "";
  const counts = new Map(daily);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const parse = (s) => new Date(`${s}T00:00`);
  const days = [];
  for (let d = parse(daily[0][0]); d <= parse(daily.at(-1)[0]); d.setDate(d.getDate() + 1)) {
    days.push([new Date(d), counts.get(iso(d)) || 0]);
  }
  const label = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  const W = 320, H = 110, TOP = 20, BOTTOM = 20, plotH = H - TOP - BOTTOM;
  const max = Math.max(...days.map(([, n]) => n), 1);
  const slot = W / days.length;
  const bw = Math.max(2, Math.min(24, slot - 2));
  const cols = days.map(([d, n], i) => {
    const x = i * slot + (slot - bw) / 2;
    const h = (n / max) * plotH;
    const y = TOP + plotH - h;
    const r = Math.min(4, h, bw / 2);
    const shape = h > 0
      ? `<path d="M${x},${TOP + plotH} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${TOP + plotH} Z" fill="#3a7bb8"/>`
      : "";
    const tip = `${label(d)}: ${fmt.format(n)} ballot${n === 1 ? "" : "s"}`;
    return shape + `<rect class="hit" x="${i * slot}" y="0" width="${slot}" height="${H - BOTTOM}" data-tip="${esc(tip)}"><title>${esc(tip)}</title></rect>`;
  }).join("");

  const [lastDay, lastN] = days.at(-1);
  const lastX = (days.length - 1) * slot + slot / 2;
  const lastY = TOP + plotH - (lastN / max) * plotH - 5;
  const total = days.reduce((a, [, n]) => a + n, 0);

  return `<div class="chart">` +
    `<h3 class="chart-title">Ballots received each day</h3>` +
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Ballots received each day, ${fmt.format(total)} in all, ${fmt.format(lastN)} on ${label(lastDay)}">` +
    `<line x1="0" x2="${W}" y1="${TOP + plotH + 0.5}" y2="${TOP + plotH + 0.5}" stroke="#d6d6d1" stroke-width="1"/>` +
    cols +
    `<text x="${Math.max(20, Math.min(lastX, W - 20))}" y="${lastY}" text-anchor="middle" class="chart-value">${fmt.format(lastN)}</text>` +
    `<text x="0" y="${H - 4}" class="chart-axis">${label(days[0][0])}</text>` +
    (days.length > 1 ? `<text x="${W}" y="${H - 4}" text-anchor="end" class="chart-axis">${label(lastDay)}</text>` : "") +
    `</svg><div class="chart-tip" hidden></div></div>`;
}

// How ballots came in (drop box, mail, email) and the drop boxes by use, from
// the matchback file's Return Method and Return Location columns.
function howReturned(r) {
  const methods = Object.entries(r.methods || {});
  if (!methods.length) return "";
  const row = (name, n, scale, value) =>
    `<li><div class="row"><span class="name">${esc(name)}</span><span class="num">${value}</span></div>` +
    `<div class="track"><div class="fill" style="width:${scale ? (100 * n) / scale : 0}%;background:#3a7bb8"></div></div></li>`;
  const total = methods.reduce((a, [, n]) => a + n, 0);
  let html = `<div class="how"><h3 class="chart-title">How ballots came in</h3><ul class="bars">` +
    methods.map(([m, n]) => row(m, n, total, `${fmt.format(n)} · ${pctText(pct(n, total))}`)).join("") + `</ul>`;

  const boxes = Object.entries(r.locations || {}).map(([name, n]) => [name.replace(/\s*Drop Box$/i, ""), n]);
  if (boxes.length) {
    const max = boxes[0][1];
    const list = (items) => `<ul class="bars">` + items.map(([b, n]) => row(b, n, max, fmt.format(n))).join("") + `</ul>`;
    html += `<h3 class="chart-title" style="margin-top:14px">Busiest drop boxes</h3>` + list(boxes.slice(0, 5)) +
      (boxes.length > 5 ? `<details class="more"><summary>Show all ${boxes.length} drop boxes</summary>${list(boxes.slice(5))}</details>` : "");
  }
  return html + `</div>`;
}

function renderSummary() {
  const d = state.data;
  const progress = ballotProgress({
    registered: d.results.registered,
    received: d.returns.returned,
    counted: d.results.ballotsCast,
    challenged: d.returns.challenged,
  }, "Lewis County");

  let html = `<h2>Countywide</h2>` + progress;
  if (state.layerName === "returned" && d.returns.available) html += receivedChart(d.returns.daily) + howReturned(d.returns);
  const c = contest();
  if (state.layerName === "results" && c) {
    const local = c.options.map((o) => o.votes);
    const wide = wideFor(c);
    html += `<h3 style="margin-top:14px;font-size:15px">${esc(c.name)}</h3>` +
      (wide ? compareBars(c.options, local, wide, optionColors(c)) : bars(c.options, local, optionColors(c)));
  }
  $("summary").innerHTML = html;
}

// The precinct card sits right under the controls, so it's in view when a
// precinct is clicked; with nothing selected it collapses to a one-line hint.
function renderDetail() {
  const name = state.selected;
  const el = $("detail");
  el.className = name ? "card detail" : "hint";
  if (!name) { el.innerHTML = `Click a precinct on the map for its details.`; return; }
  const feat = state.geoLayer?.getLayers().find((l) => l.feature.properties.name === name)?.feature.properties || {};
  const p = precinct(name);
  const progress = ballotProgress({
    registered: p.registered || 0,
    received: p.returned,
    counted: p.counted || 0,
    challenged: p.challenged,
  }, "this precinct", true);

  let html = `<div class="detail-head"><h3>${esc(name)}</h3><button class="close" type="button" aria-label="Close precinct details" title="Close (Esc)">&times;</button></div>` +
    `<p class="muted" style="margin-bottom:10px">Precinct ${esc(feat.num ?? "")} · LD ${esc(feat.ld ?? "–")} · CD ${esc(feat.cd ?? "–")}</p>` + progress;
  const c = contest();
  if (state.layerName === "results" && c) {
    const votes = c.precincts[name];
    html += `<p class="muted" style="margin-top:12px">${esc(c.name)}</p>` +
      (votes ? bars(c.options, votes, optionColors(c)) : `<p class="muted">No precinct results for this contest here.</p>`);
  }
  $("detail").innerHTML = html;
}

// Counties can't tabulate or release results before 8 p.m. on Election Day
// (RCW 29A.40.110, per the Secretary of State).
function releaseTime(electionId) {
  const day = new Date(+electionId.slice(0, 4), +electionId.slice(4, 6) - 1, +electionId.slice(6, 8));
  return `8 p.m. on Election Day (${day.toLocaleDateString("en-US", { month: "short", day: "numeric" })})`;
}

function renderNotice() {
  const d = state.data;
  let msg = "";
  if (state.layerName === "returned" && !d.returns.available) {
    msg = `Ballots-received figures aren't available for this election. For current elections they're added once a day from the
      <a href="https://www.sos.wa.gov/elections/data-research/election-data-and-maps/ballot-status-reports" target="_blank" rel="noopener">Secretary of State's</a>
      ballot status report.`;
  } else if (state.layerName === "results" && !d.results.hasPrecinctResults) {
    msg = d.results.ballotsCast
      ? `The county hasn't published results by precinct yet. Countywide totals are shown below.`
      : `No results yet. The map fills in once counting starts at ${releaseTime(d.id)}.`;
  }
  $("notice").hidden = !msg;
  $("notice").innerHTML = msg;
}

function renderStatus() {
  const d = state.data;
  const source = `<a href="https://results.votewa.gov/results/public/lewis-county-wa/elections/${esc(d.id)}" target="_blank" rel="noopener">county results</a>`;
  let results;
  if (state.live === false) {
    results = `<b>Live ${source} unreachable</b> - showing a snapshot from ${when(d.generatedAt)}. Retrying every minute.`;
  } else {
    results = `Results: live from ${source}${d.results.official ? " (<b>final</b>)" : ""}, county update ${when(d.results.lastUpdated)}. ` +
      `Checked ${state.liveCheckedAt ? state.liveCheckedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "–"}.`;
  }
  const returns = d.returns.available ? `Ballots received: state data posted ${when(d.returns.fileTime)}.` : null;
  $("status").innerHTML = [results, returns].filter(Boolean).join("<br>");
}

// Sections for the contest picker, matched on contest names, in ballot order.
const GROUPS = [
  ["Statewide measures", (c) => c.type === "BallotMeasure" && c.counties >= 39],
  ["Federal", (c) => /\bU\.?S\.? (Representative|Senator)|Congressional/i.test(c.name)],
  ["State legislature", (c) => /Legislative District|State (Representative|Senator)/i.test(c.name)],
  ["Courts", (c) => /Court|Judge|Justice/i.test(c.name)],
  ["County offices", (c) => /^(Assessor|Auditor|Clerk|Coroner|Prosecuting Attorney|Sheriff|Treasurer)$|County Commissioner/i.test(c.name)],
  ["Party precinct committee officers", (c) => /Precinct Committee Officer/i.test(c.name)],
  ["Local measures and districts", () => true],
];

function contestGroups(contests) {
  const groups = GROUPS.map(([label]) => [label, []]);
  for (const c of contests) groups[GROUPS.findIndex(([, test]) => test(c))][1].push(c);
  return groups.filter(([, list]) => list.length);
}

function renderControls() {
  document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.layer === state.layerName)));
  $("contest-wrap").hidden = state.layerName !== "results";
  $("layer-desc").textContent = state.layerName === "results"
    ? "Votes counted so far, updated live."
    : "Ballots the county has received, updated daily.";
  const sel = $("contest");
  // Rebuild when live data arrives too: the saved snapshot has no county counts.
  const key = state.data.contests.map((c) => `${c.id}:${c.counties}`).join(",");
  if (sel.dataset.key !== key) {
    sel.innerHTML = contestGroups(state.data.contests).map(([group, list]) =>
      `<optgroup label="${esc(group)}">` + list.map((c) => {
        const vs = c.counties >= 39 ? " · vs. statewide" : c.counties > 1 ? " · vs. district" : "";
        return `<option value="${c.id}">${esc(c.name)}${vs}</option>`;
      }).join("") + `</optgroup>`).join("");
    sel.dataset.key = key;
  }
  const c = contest();
  if (c) sel.value = c.id;
}

function renderAll() {
  renderUpdated();
  renderControls();
  renderNotice();
  renderSummary();
  renderDetail();
  renderStatus();
  restyle();
  writeUrl();
  renderTable();
}

// ---------------------------------------------------------- shareable links

// The view lives in the address bar (?e=20261103&view=results&contest=sheriff&p=12),
// so a copied or shared link opens the same election, tab, contest and precinct.
const slug = (s) => norm(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function featureFor(name) {
  return state.geoLayer?.getLayers().find((l) => l.feature.properties.name === name)?.feature.properties;
}

function writeUrl() {
  if (!state.data) return;
  const q = new URLSearchParams({ e: state.electionId, view: state.layerName === "results" ? "results" : "received" });
  const c = contest();
  if (state.layerName === "results" && c) q.set("contest", slug(c.name));
  const num = state.selected && featureFor(state.selected)?.num;
  if (num != null) q.set("p", num);
  const url = `${location.pathname}?${q}`;
  if (url !== location.pathname + location.search) history.replaceState(null, "", url);
}

// Apply ?view, ?contest and ?p from a shared link once the election has loaded.
function readUrl(q) {
  if (q.get("view")) {
    state.layerName = q.get("view") === "results" ? "results" : "returned";
    state.userPickedLayer = true;
  }
  const c = state.data.contests.find((x) => slug(x.name) === q.get("contest"));
  if (c) state.contestId = c.id;
  const f = state.geoLayer.getLayers().find((l) => String(l.feature.properties.num) === q.get("p"));
  if (f) state.selected = f.feature.properties.name;
}

// Copies the link to this view. The Clipboard API needs a secure context and
// focus; the hidden-textarea copy covers older browsers.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text, readOnly: true });
    ta.style.cssText = "position:fixed;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

async function shareView() {
  const btn = $("share");
  const ok = await copyText(location.href);
  btn.textContent = ok ? "✓ Link copied" : "Copy the address bar";
  btn.classList.toggle("done", ok);
  clearTimeout(shareView.timer);
  shareView.timer = setTimeout(() => {
    btn.textContent = "🔗 Share this view";
    btn.classList.remove("done");
  }, 2500);
}

// ------------------------------------------------------------------ loading

function defaultLayer(d) {
  if (d.results.ballotsCast) return "results";
  return "returned";
}

async function loadElection(id, linkParams = null) {
  const [geo, data] = await Promise.all([getJSON(`data/${id}.geojson`), getJSON(`data/${id}.json`)]);
  state.electionId = id;
  state.data = data;
  state.precinctKey = precinctKeys(geo);
  state.selected = null;
  state.contestId = null;
  state.live = null;
  state.wide = new Map();
  state.lastSeenUpdate = null;
  state.newResults = false;
  state.userPickedLayer = false;
  state.layerName = defaultLayer(data);
  state.breaks = rateBreaks();  // styleFor needs these for the first draw

  state.geoLayer?.remove();
  state.geoLayer = L.geoJSON(geo, {
    style: styleFor,
    onEachFeature: (f, layer) => {
      layer.bindTooltip(() => tooltipFor(f.properties.name), { sticky: true });
      layer.on("click", () => selectPrecinct(state.selected === f.properties.name ? null : f.properties.name));
    },
  }).addTo(map);
  if (linkParams) readUrl(linkParams);
  state.needsFit = true;
  fitToPrecincts();
  renderAll();
  refreshStatic();
  await refreshLive();
}

// Clicking a precinct again, the close button or Esc clears the selection.
function selectPrecinct(name) {
  state.selected = name;
  renderDetail();
  restyle();
  writeUrl();
  if (name) {
    const el = $("detail");
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el.classList.remove("flash");
    void el.offsetWidth;  // restart the highlight animation
    el.classList.add("flash");
  }
}

// Fitting while the map has no size (page loaded in a hidden tab) zooms all the
// way in, so wait until the container has real dimensions.
function fitToPrecincts() {
  map.invalidateSize();
  const size = map.getSize();
  if (!state.needsFit || !state.geoLayer || !size.x || !size.y) return;
  // Fit at an exact zoom: the map's 0.25 zoom step would round down and leave
  // up to ~15% extra margin, which shows on a phone. Leaflet applies the step
  // in both calls, so lift it while fitting.
  const snap = map.options.zoomSnap;
  map.options.zoomSnap = 0;
  map.fitBounds(state.geoLayer.getBounds(), { padding: [8, 8], animate: false });
  map.options.zoomSnap = snap;
  state.needsFit = false;
}
new ResizeObserver(fitToPrecincts).observe($("map"));

function tooltipFor(name) {
  const p = precinct(name);
  let line;
  if (state.layerName === "results") {
    const lead = leaderFor(name);
    line = lead ? `${esc(contest().options[lead.idx].name)} ${(100 * lead.share).toFixed(1)}%`
      : contest()?.precincts[name] ? "No votes reported" : "No precinct results for this contest";
  } else {
    line = p.returned == null ? "No data"
      : `${fmt.format(p.returned)} of ${fmt.format(p.registered || 0)} voters · ${pctText(pct(p.returned, p.registered))}`;
  }
  return `<b>${esc(name)}</b><br>${line}`;
}

// ---------------------------------------------------------------- table view

// A sortable table of every precinct for the current tab (and contest), with
// a countywide total row and a CSV download of exactly what's shown.
state.sort = { key: "name", dir: 1 };

function tableModel() {
  const d = state.data;
  const precincts = state.geoLayer.getLayers().map((l) => l.feature.properties);
  const c = contest();
  if (state.layerName === "results" && c) {
    const totalFor = (votes) => (votes ? votes.reduce((a, b) => a + b, 0) : null);
    const columns = [
      { key: "name", label: "Precinct" },
      { key: "total", label: "Votes", num: true },
      ...c.options.map((o, i) => ({ key: `o${i}`, label: o.name, num: true, pctOf: "total" })),
    ];
    // Only precincts with results: district contests cover a few precincts, and
    // the county withholds some tiny ones.
    const rows = precincts.filter((f) => c.precincts[f.name]).map((f) => {
      const votes = c.precincts[f.name];
      const row = { name: f.name, num: f.num, total: totalFor(votes) };
      c.options.forEach((_, i) => { row[`o${i}`] = votes[i]; });
      return row;
    });
    const total = { name: "Lewis County", total: c.options.reduce((a, o) => a + o.votes, 0) };
    c.options.forEach((o, i) => { total[`o${i}`] = o.votes; });
    const title = rows.length ? `${c.name} — results by precinct` : `${c.name} — no precinct results yet`;
    return { title, file: slug(c.name), columns, rows, total };
  }

  const columns = [
    { key: "name", label: "Precinct" },
    { key: "ld", label: "Leg. district", num: true },
    { key: "registered", label: "Registered voters", num: true },
    ...(d.returns.available ? [
      { key: "returned", label: "Ballots received", num: true, pctOf: "registered" },
      { key: "challenged", label: "Challenged", num: true },
    ] : []),
    ...(d.results.ballotsCast ? [{ key: "counted", label: "Ballots counted", num: true, pctOf: "registered" }] : []),
  ];
  const rows = precincts.map((f) => {
    const p = precinct(f.name);
    return { name: f.name, num: f.num, ld: f.ld, registered: p.registered ?? null, returned: p.returned ?? 0,
      challenged: p.challenged ?? 0, counted: p.counted ?? 0 };
  });
  const total = { name: "Lewis County", ld: null, registered: d.results.registered, returned: d.returns.returned,
    challenged: d.returns.challenged, counted: d.results.ballotsCast };
  return { title: "Ballots received by precinct", file: "ballots-received", columns, rows, total };
}

function renderTable() {
  if ($("table-view").hidden) return;
  const m = tableModel();
  const { key, dir } = state.sort;
  const col = m.columns.find((c) => c.key === key) || m.columns[0];
  m.rows.sort((a, b) => {
    const x = a[col.key], y = b[col.key];
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;  // blanks last
    return (col.num ? x - y : String(x).localeCompare(String(y), "en", { numeric: true })) * dir;
  });
  const cell = (row, c) => {
    const v = row[c.key];
    if (c.key === "name") return esc(v);
    if (v == null) return "–";
    const share = c.pctOf && row[c.pctOf] ? `<small>${pctText(pct(v, row[c.pctOf]))}</small>` : "";
    return fmt.format(v) + share;
  };
  $("table-title").textContent = m.title;
  $("table").innerHTML =
    `<thead><tr>${m.columns.map((c) => `<th scope="col" data-key="${c.key}"${c.key === col.key ? ` aria-sort="${dir > 0 ? "ascending" : "descending"}"` : ""}>${esc(c.label)}</th>`).join("")}</tr></thead>` +
    `<tbody>${m.rows.map((r) => `<tr data-name="${esc(r.name)}">${m.columns.map((c) => `<td>${cell(r, c)}</td>`).join("")}</tr>`).join("")}</tbody>` +
    `<tfoot><tr>${m.columns.map((c) => `<td>${cell(m.total, c)}</td>`).join("")}</tr></tfoot>`;
}

function csvText(m) {
  const quote = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const header = ["Precinct", "Precinct number", ...m.columns.slice(1).map((c) => c.label)];
  const lines = [header, ...m.rows.map((r) => [r.name, r.num, ...m.columns.slice(1).map((c) => r[c.key])]),
    [m.total.name, "", ...m.columns.slice(1).map((c) => m.total[c.key])]];
  return lines.map((l) => l.map(quote).join(",")).join("\r\n");
}

function downloadCsv() {
  const m = tableModel();
  const blob = new Blob([csvText(m)], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `lewis-county-${state.electionId}-${m.file}.csv`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function openTable(open) {
  $("table-view").hidden = !open;
  if (open) { renderTable(); $("table-close").focus(); } else { $("open-table").focus(); }
}

// --------------------------------------------------------- find my precinct

// An address is geocoded by the U.S. Census Bureau through the Worker (the
// Census service sends no CORS header); "Use my location" stays on the device.
// Either way the point is matched to a precinct here in the browser.

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function precinctAt(lng, lat) {
  for (const layer of state.geoLayer.getLayers()) {
    const g = layer.feature.geometry;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    if (polys.some(([outer, ...holes]) => inRing(lng, lat, outer) && !holes.some((h) => inRing(lng, lat, h)))) return layer;
  }
  return null;
}

let findMarker = null;
// Its own pane, above the precincts and their labels: restyle() brings the
// selected precinct to the front, which would otherwise cover the dot.
map.createPane("found").style.zIndex = 460;

function findMessage(text, error = false, clearable = false) {
  $("find-msg").textContent = text;
  $("find-msg").classList.toggle("error", error);
  if (clearable) $("find-msg").insertAdjacentHTML("beforeend", `<button class="find-clear" type="button">Clear</button>`);
}

// Clearing the search (the box's x, emptying it, or Clear) removes the dot,
// deselects the precinct and zooms back out to the whole county.
function clearFind() {
  findMarker?.remove();
  findMarker = null;
  $("find-address").value = "";
  findMessage("");
  if (state.selected) selectPrecinct(null);
  state.needsFit = true;
  fitToPrecincts();
}

function toggleFind(open = $("find").hidden) {
  $("find").hidden = !open;
  $("find-toggle").setAttribute("aria-expanded", String(open));
  if (open) $("find-address").focus();
}

function showLocation(lng, lat, label) {
  findMarker?.remove();
  const layer = precinctAt(lng, lat);
  if (!layer) {
    findMessage(`${label} isn't in Lewis County.`, true);
    return;
  }
  findMarker = L.circleMarker([lat, lng], { pane: "found", radius: 7, color: "#fff", weight: 3, fillColor: "#c43b3b", fillOpacity: 1 })
    .bindTooltip(esc(label)).addTo(map);
  findMessage(`${label} is in precinct ${layer.feature.properties.name}.`, false, true);
  map.flyToBounds(layer.getBounds(), { maxZoom: 13, padding: [24, 24], duration: 0.6 });
  selectPrecinct(layer.feature.properties.name);
}

async function findAddress(text) {
  if (!PROXY) { findMessage("Address search isn't available right now.", true); return; }
  // The geocoder needs a state; most people will type just "street, city".
  const query = /\b(WA|Washington)\b|\b\d{5}\b/i.test(text) ? text : `${text}, WA`;
  const btn = $("find").querySelector("button[type=submit]");
  btn.disabled = true;
  findMessage("Looking up that address…");
  try {
    const { matches } = await getJSON(`${PROXY}/geocode?address=${encodeURIComponent(query)}`, false);
    if (!matches?.length) {
      findMessage("Couldn't find that address. Try including the city, like “123 Main St, Chehalis”.", true);
      return;
    }
    const m = matches[0];
    showLocation(m.lng, m.lat, m.address.replace(/, \d{5}$/, ""));
  } catch (err) {
    console.warn("geocode failed", err);
    findMessage("The address lookup isn't responding. Please try again in a moment.", true);
  } finally {
    btn.disabled = false;
  }
}

function findMe() {
  if (!navigator.geolocation) { findMessage("Your browser can't share its location.", true); return; }
  findMessage("Finding your location…");
  navigator.geolocation.getCurrentPosition(
    (pos) => showLocation(pos.coords.longitude, pos.coords.latitude, "Your location"),
    () => findMessage("Couldn't get your location. You can type an address instead.", true),
    { enableHighAccuracy: true, timeout: 10000 },
  );
}

// ------------------------------------------------------------------- events

$("find").addEventListener("submit", (e) => { e.preventDefault(); findAddress($("find-address").value.trim()); });
$("locate").addEventListener("click", findMe);
$("find-toggle").addEventListener("click", () => toggleFind());
// The search box's built-in x (or deleting the text) empties it: clear the result.
$("find-address").addEventListener("input", (e) => { if (!e.target.value && (findMarker || $("find-msg").textContent)) clearFind(); });
$("find-msg").addEventListener("click", (e) => { if (e.target.closest(".find-clear")) clearFind(); });

$("election").addEventListener("change", (e) => loadElection(e.target.value));
$("contest").addEventListener("change", (e) => { state.contestId = e.target.value; renderAll(); loadBreakdown(); });
$("detail").addEventListener("click", (e) => { if (e.target.closest(".close")) selectPrecinct(null); });
$("share").addEventListener("click", shareView);

// Hover tooltip for chart columns (each has a data-tip and a wide hit area).
$("summary").addEventListener("pointermove", (e) => {
  const hit = e.target.closest("[data-tip]");
  const chart = e.target.closest(".chart");
  const tip = chart?.querySelector(".chart-tip");
  chart?.querySelectorAll(".hit.on").forEach((h) => h !== hit && h.classList.remove("on"));
  if (!tip) return;
  if (!hit) { tip.hidden = true; return; }
  hit.classList.add("on");
  const box = chart.getBoundingClientRect();
  tip.textContent = hit.dataset.tip;
  tip.hidden = false;
  tip.style.left = `${Math.min(e.clientX - box.left + 10, box.width - tip.offsetWidth)}px`;
  tip.style.top = `${e.clientY - box.top - 34}px`;
});
$("summary").addEventListener("pointerleave", () => {
  $("summary").querySelectorAll(".chart-tip").forEach((t) => { t.hidden = true; });
  $("summary").querySelectorAll(".hit.on").forEach((h) => h.classList.remove("on"));
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("table-view").hidden) openTable(false);
  else if (state.selected) selectPrecinct(null);
});
$("open-table").addEventListener("click", () => openTable(true));
$("table-close").addEventListener("click", () => openTable(false));
$("csv").addEventListener("click", downloadCsv);
$("table").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-key]");
  if (th) {
    const key = th.dataset.key;
    state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : key === "name" ? 1 : -1 };
    renderTable();
    return;
  }
  const tr = e.target.closest("tbody tr");
  if (tr) {
    openTable(false);
    const layer = state.geoLayer.getLayers().find((l) => l.feature.properties.name === tr.dataset.name);
    if (layer) map.flyToBounds(layer.getBounds(), { maxZoom: 13, padding: [24, 24], duration: 0.6 });
    selectPrecinct(tr.dataset.name);
  }
});
document.querySelectorAll(".seg button").forEach((b) =>
  b.addEventListener("click", () => {
    state.layerName = b.dataset.layer;
    state.userPickedLayer = true;
    renderAll();
    loadBreakdown();
  }));

(async function init() {
  state.elections = await getJSON("data/elections.json");
  $("election").innerHTML = state.elections.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("");
  const link = new URLSearchParams(location.search);
  const first = state.elections.find((e) => e.id === link.get("e"))?.id || state.elections[0].id;
  $("election").value = first;
  await loadElection(first, link);
  setInterval(refreshLive, LIVE_MS);
  setInterval(refreshStatic, STATIC_MS);
})();
