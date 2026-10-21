// Lewis County election map: precinct choropleth of ballots received and
// contest results.
//
// Results come live from the county's results.votewa.gov feed: the summary
// every LIVE_MS, and precinct results for the contest being viewed. site/data/
// (written by scripts/build.py) holds the boundaries, the daily ballot-return
// totals, and a results snapshot used when the live feed can't be reached.

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

// Colors go to options in order of countywide votes so the front-runners always
// get distinct hues; each party's top vote-getter gets the party color.
function optionColors(c) {
  if (c._colors) return c._colors;
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
  renderAll();
  loadBreakdown();
}

// Ballot-return totals change once a day, when a new build is published.
async function refreshStatic() {
  try {
    const fresh = await getJSON(`data/${state.electionId}.json`);
    if (fresh.id !== state.electionId || fresh.generatedAt === state.data.generatedAt) return;
    const d = state.data;
    d.generatedAt = fresh.generatedAt;
    d.returns = fresh.returns;
    for (const [name, p] of Object.entries(fresh.precincts)) {
      const target = (d.precincts[name] ||= {});
      for (const key of ["returned", "accepted", "challenged"]) target[key] = p[key];
    }
    renderAll();
  } catch (err) {
    console.warn("returns refresh failed", err);
  }
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
    const colors = optionColors(c);
    const leaders = new Set(Object.keys(c.precincts).map((n) => leaderFor(n)?.idx));
    const shown = c.options.map((o, i) => [o, i]).filter(([, i]) => leaders.has(i) || !Object.keys(c.precincts).length);
    el.innerHTML = `<b>Leader by precinct</b>` +
      shown.map(([o, i]) => `<div><i style="background:${colors[i]}"></i>${esc(o.name)}</div>`).join("") +
      `<div class="muted" style="margin-top:4px">Darker = larger lead</div>` +
      `<div><i style="background:${NO_DATA}"></i>No precinct results</div>`;
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

function renderSummary() {
  const d = state.data;
  const progress = ballotProgress({
    registered: d.results.registered,
    received: d.returns.returned,
    counted: d.results.ballotsCast,
    challenged: d.returns.challenged,
  }, "Lewis County");

  let html = `<h2>Countywide</h2>` + progress;
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

function renderControls() {
  document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.layer === state.layerName)));
  $("contest-wrap").hidden = state.layerName !== "results";
  $("layer-desc").textContent = state.layerName === "results"
    ? "Votes counted so far, updated live."
    : "Ballots the county has received, updated daily.";
  const sel = $("contest");
  const key = state.data.contests.map((c) => c.id).join(",");
  if (sel.dataset.key !== key) {
    sel.innerHTML = state.data.contests.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    sel.dataset.key = key;
  }
  const c = contest();
  if (c) sel.value = c.id;
}

function renderAll() {
  renderControls();
  renderNotice();
  renderSummary();
  renderDetail();
  renderStatus();
  restyle();
}

// ------------------------------------------------------------------ loading

function defaultLayer(d) {
  if (d.results.ballotsCast) return "results";
  return "returned";
}

async function loadElection(id) {
  const [geo, data] = await Promise.all([getJSON(`data/${id}.geojson`), getJSON(`data/${id}.json`)]);
  state.electionId = id;
  state.data = data;
  state.selected = null;
  state.contestId = null;
  state.live = null;
  state.wide = new Map();
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
  state.needsFit = true;
  fitToPrecincts();
  renderAll();
  await refreshLive();
}

// Clicking a precinct again, the close button or Esc clears the selection.
function selectPrecinct(name) {
  state.selected = name;
  renderDetail();
  restyle();
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

// ------------------------------------------------------------------- events

$("election").addEventListener("change", (e) => loadElection(e.target.value));
$("contest").addEventListener("change", (e) => { state.contestId = e.target.value; renderAll(); loadBreakdown(); });
$("detail").addEventListener("click", (e) => { if (e.target.closest(".close")) selectPrecinct(null); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.selected) selectPrecinct(null); });
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
  await loadElection(state.elections[0].id);
  setInterval(refreshLive, LIVE_MS);
  setInterval(refreshStatic, STATIC_MS);
})();
