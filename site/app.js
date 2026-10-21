// Lewis County election map: precinct choropleth of ballot returns, ballots
// counted and contest results. Data comes from site/data/, written by
// scripts/build.py; the page re-reads it every REFRESH_MS.

const REFRESH_MS = 2 * 60 * 1000;
const SEQ = ["#dbe8f4", "#a8c8e4", "#6fa3d0", "#3a7bb8", "#15508e"];
const OPTION_COLORS = ["#2d6fb5", "#c4572a", "#3a8a55", "#7a4fb8", "#b48a1c", "#2b8a8a", "#a8326e", "#5d6b78"];
const PARTY_COLORS = { DEM: "#2d6fb5", REP: "#c43b3b" };
const NO_DATA = "#d9d9d4";

const fmt = new Intl.NumberFormat("en-US");
const pct = (n, d) => (d > 0 ? (100 * n) / d : null);
const pctText = (v) => (v == null ? "–" : `${v.toFixed(1)}%`);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const state = {
  elections: [],
  electionId: null,
  data: null,
  layerName: null,
  contestIdx: 0,
  selected: null,
  geoLayer: null,
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

async function getJSON(path) {
  const res = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function precinct(name) {
  return state.data?.precincts[name] || {};
}

function contest() {
  return state.data?.contests[state.contestIdx];
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

// ------------------------------------------------------------------- styling

// Rate layers: share of registered voters, binned on a scale that stretches to
// the current maximum so early returns (5-20%) still show contrast.
function rateFor(name) {
  const p = precinct(name);
  const n = state.layerName === "returned" ? p.returned : p.counted;
  if (n == null || !p.registered) return null;
  return pct(n, p.registered);
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
  const label = state.layerName === "returned" ? "Ballots returned" : "Ballots counted";
  let lo = 0;
  el.innerHTML = `<b>${label}, % of registered</b>` +
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

function statBlock(rows) {
  return `<dl class="stats">` + rows.map(([label, value, note]) =>
    `<div><dt>${label}</dt><dd>${value}${note ? ` <small>${note}</small>` : ""}</dd></div>`).join("") + `</dl>`;
}

function renderSummary() {
  const d = state.data;
  const reg = d.results.registered;
  const rows = [["Registered", fmt.format(reg)]];
  if (d.returns.available) rows.push(["Returned", fmt.format(d.returns.returned), pctText(pct(d.returns.returned, reg))]);
  rows.push(["Counted", fmt.format(d.results.ballotsCast), pctText(pct(d.results.ballotsCast, reg))]);
  if (d.returns.available && d.returns.challenged) rows.push(["Challenged", fmt.format(d.returns.challenged)]);

  let html = `<h2>Countywide</h2>` + statBlock(rows);
  const c = contest();
  if (state.layerName === "results" && c) {
    html += `<h3 style="margin-top:14px;font-size:15px">${esc(c.name)}</h3>` +
      bars(c.options, c.options.map((o) => o.votes), optionColors(c));
  }
  $("summary").innerHTML = html;
}

function renderDetail() {
  const name = state.selected;
  if (!name) { $("detail").innerHTML = `<p class="muted">Click a precinct for details.</p>`; return; }
  const feat = state.geoLayer?.getLayers().find((l) => l.feature.properties.name === name)?.feature.properties || {};
  const p = precinct(name);
  const rows = [["Registered", p.registered != null ? fmt.format(p.registered) : "–"]];
  if (state.data.returns.available) rows.push(["Returned", fmt.format(p.returned || 0), pctText(pct(p.returned || 0, p.registered))]);
  rows.push(["Counted", p.counted != null ? fmt.format(p.counted) : "–", pctText(pct(p.counted, p.registered))]);
  if (state.data.returns.available && p.challenged) rows.push(["Challenged", fmt.format(p.challenged)]);

  let html = `<h3>${esc(name)}</h3><p class="muted" style="margin-bottom:10px">Precinct ${esc(feat.num ?? "")} · LD ${esc(feat.ld ?? "–")} · CD ${esc(feat.cd ?? "–")}</p>` + statBlock(rows);
  const c = contest();
  if (state.layerName === "results" && c) {
    const votes = c.precincts[name];
    html += `<p class="muted" style="margin-top:12px">${esc(c.name)}</p>` +
      (votes ? bars(c.options, votes, optionColors(c)) : `<p class="muted">No precinct results for this contest here.</p>`);
  }
  $("detail").innerHTML = html;
}

function renderNotice() {
  const d = state.data;
  let msg = "";
  if (state.layerName === "returned" && !d.returns.available) {
    msg = `No ballot return (matchback) file loaded for this election yet. Download the Daily Ballot Status Report from the
      <a href="https://www.sos.wa.gov/elections/data-research/election-data-and-maps/ballot-status-reports" target="_blank" rel="noopener">Secretary of State</a>,
      drop it in <code>data/matchback/${esc(d.id)}/</code>, and the next build will pick it up.`;
  } else if (state.layerName === "counted" && !d.results.ballotsCast) {
    msg = `No ballots counted yet. Counts appear here once the county posts its first results on election night.`;
  } else if (state.layerName === "results" && !d.results.hasPrecinctResults) {
    msg = d.results.ballotsCast
      ? `The county hasn't published precinct-level results for this election yet. Countywide totals are shown at left.`
      : `No results yet. They appear here once the county posts its first count on election night.`;
  }
  $("notice").hidden = !msg;
  $("notice").innerHTML = msg;
}

function renderStatus() {
  const d = state.data;
  const when = (iso) => iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "–";
  const parts = [
    `Results feed: ${d.results.official ? "<b>final</b>, " : ""}as of ${when(d.results.asOf)} (<a href="${esc(d.results.url)}" target="_blank" rel="noopener">source</a>)`,
    d.returns.available ? `Returns file: ${esc(d.returns.source)}, saved ${when(d.returns.fileTime)}` : null,
    `Data built ${when(d.generatedAt)} · page checks for updates every ${REFRESH_MS / 60000} min`,
  ];
  $("status").innerHTML = parts.filter(Boolean).join("<br>");
}

function renderControls() {
  document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.layer === state.layerName)));
  $("contest-wrap").hidden = state.layerName !== "results";
  const sel = $("contest");
  const names = state.data.contests.map((c) => c.name);
  if (sel.dataset.for !== state.data.id) {
    sel.innerHTML = names.map((n, i) => `<option value="${i}">${esc(n)}</option>`).join("");
    sel.dataset.for = state.data.id;
  }
  sel.value = String(state.contestIdx);
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
  if (d.results.hasPrecinctResults) return "results";
  if (d.results.ballotsCast) return "counted";
  return "returned";
}

async function loadElection(id) {
  const [geo, data] = await Promise.all([getJSON(`data/${id}.geojson`), getJSON(`data/${id}.json`)]);
  state.electionId = id;
  state.data = data;
  state.selected = null;
  state.contestIdx = 0;
  state.layerName = defaultLayer(data);

  state.geoLayer?.remove();
  state.geoLayer = L.geoJSON(geo, {
    style: styleFor,
    onEachFeature: (f, layer) => {
      layer.bindTooltip(() => tooltipFor(f.properties.name), { sticky: true });
      layer.on("click", () => { state.selected = f.properties.name; renderDetail(); restyle(); });
    },
  }).addTo(map);
  map.invalidateSize();
  map.fitBounds(state.geoLayer.getBounds(), { padding: [12, 12] });
  renderAll();
}

function tooltipFor(name) {
  const p = precinct(name);
  let line;
  if (state.layerName === "results") {
    const lead = leaderFor(name);
    line = lead ? `${esc(contest().options[lead.idx].name)} ${(100 * lead.share).toFixed(1)}%`
      : contest()?.precincts[name] ? "No votes reported" : "No precinct results for this contest";
  } else {
    const n = state.layerName === "returned" ? p.returned : p.counted;
    line = n == null ? "No data" : `${fmt.format(n)} of ${fmt.format(p.registered || 0)} · ${pctText(pct(n, p.registered))}`;
  }
  return `<b>${esc(name)}</b><br>${line}`;
}

async function refresh() {
  try {
    const data = await getJSON(`data/${state.electionId}.json`);
    if (data.generatedAt !== state.data.generatedAt) {
      state.data = data;
      renderAll();
    }
  } catch (err) {
    console.warn("refresh failed", err);
  }
}

// ------------------------------------------------------------------- events

$("election").addEventListener("change", (e) => loadElection(e.target.value));
$("contest").addEventListener("change", (e) => { state.contestIdx = Number(e.target.value); renderAll(); });
document.querySelectorAll(".seg button").forEach((b) =>
  b.addEventListener("click", () => { state.layerName = b.dataset.layer; renderAll(); }));

(async function init() {
  state.elections = await getJSON("data/elections.json");
  $("election").innerHTML = state.elections.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("");
  await loadElection(state.elections[0].id);
  setInterval(refresh, REFRESH_MS);
})();
