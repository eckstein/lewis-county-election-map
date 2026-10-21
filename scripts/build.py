"""Build map data for the Lewis County, WA elections dashboard.

For each configured election this writes, under site/data/:
  <id>.geojson  precinct boundaries (from the Secretary of State statewide shapefile)
  <id>.json     per-precinct ballots returned (matchback), plus a snapshot of
                registration, ballots counted and contest results from
                results.votewa.gov. The page loads results live from that feed
                and only uses the snapshot if the feed can't be reached.
  elections.json  list of elections for the page's selector

Ballot returns come from the SOS "Daily Ballot Status Report" (matchback). For the
current election the build downloads the county's file from a fixed SOS URL into
data/matchback/<election id>/; a file dropped there by hand (zip, csv or txt) also
works. The newest file there is used. Only precinct totals are written out - never
voter-level rows.

Usage:
  python scripts/build.py                 build once
  python scripts/build.py --watch 300     rebuild every 300 seconds
"""

import argparse
import csv
import datetime as dt
import email.utils
import io
import json
import os
import sys
import time
import urllib.request
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import shapefile  # pyshp

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "cache"
MATCHBACK = ROOT / "data" / "matchback"
RETURNS = ROOT / "data" / "returns"
OUT = ROOT / "site" / "data"

COUNTY_NAME = "LEWIS"
COUNTY_SLUG = "lewis-county-wa"
RESULTS_API = "https://results.votewa.gov/results/public/api/elections"
SOS_FILES = "https://www.sos.wa.gov/sites/default/files"

# Newest first; the page opens on the first one. "matchback" is the SOS file for
# whatever election is current, so it's only used when its Election column
# matches "matchback_election".
ELECTIONS = [
    {"id": "20261103", "name": "2026 General",
     "shapefile": f"{SOS_FILES}/2026-10/Statewide_Precincts_2026General_0.zip",
     "matchback": f"{SOS_FILES}/current_election/Lewis.csv",
     "matchback_election": "General Nov 3 2026"},
    {"id": "20260804", "name": "2026 Primary",
     "shapefile": f"{SOS_FILES}/2026-09/Statewide_Precincts_2026Primary_0.zip"},
]

UA = {"User-Agent": "Mozilla/5.0 (LC Elections Dashboard prototype)"}

# Matchback statuses that mean the ballot has not come back yet.
NOT_RETURNED = {"", "issued", "sent", "mailed", "undeliverable", "not returned", "none"}
LEWIS_CODES = {"LE", "LEWIS", "53041", "041", "21"}


def log(*args):
    print(*args, flush=True)


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def fetch_json(url):
    return json.loads(fetch(url).decode("utf-8"))


def text(localized):
    """Pick the English string from the results API's [{languageId, text}] lists."""
    if not localized:
        return ""
    for item in localized:
        if item.get("languageId") == "en":
            return item.get("text") or ""
    return localized[0].get("text") or ""


def norm(name):
    return " ".join(str(name).upper().split())


# ---------------------------------------------------------------- boundaries

def round_ring(ring):
    out = []
    for x, y in ring:
        pt = [round(x, 5), round(y, 5)]
        if not out or out[-1] != pt:
            out.append(pt)
    return out


def build_boundaries(election):
    out_path = OUT / f"{election['id']}.geojson"
    if out_path.exists():
        return json.loads(out_path.read_text(encoding="utf-8"))

    zip_path = CACHE / Path(election["shapefile"]).name
    if not zip_path.exists():
        log(f"  downloading {election['shapefile']}")
        zip_path.write_bytes(fetch(election["shapefile"], timeout=300))

    with zipfile.ZipFile(zip_path) as zf:
        stem = next(Path(n).stem for n in zf.namelist() if n.lower().endswith(".shp"))
        files = {ext: io.BytesIO(zf.read(f"{stem}.{ext}")) for ext in ("shp", "shx", "dbf")}
    reader = shapefile.Reader(**files)

    features = []
    for sr in reader.iterShapeRecords():
        rec = sr.record.as_dict()
        # Field sets differ between releases; CountyName is present in all of them.
        if str(rec.get("CountyName", "")).strip().upper() != COUNTY_NAME:
            continue
        geom = sr.shape.__geo_interface__
        if geom["type"] == "Polygon":
            geom = {"type": "Polygon", "coordinates": [round_ring(r) for r in geom["coordinates"]]}
        else:
            geom = {"type": "MultiPolygon",
                    "coordinates": [[round_ring(r) for r in poly] for poly in geom["coordinates"]]}
        features.append({
            "type": "Feature",
            "properties": {"name": norm(rec["PrecinctNa"]), "num": rec["PrecinctNu"],
                           "code": rec["St_Code"], "cd": int(rec["CD"]), "ld": int(rec["LD"])},
            "geometry": geom,
        })
    features.sort(key=lambda f: f["properties"]["num"])
    gj = {"type": "FeatureCollection", "features": features}
    out_path.write_text(json.dumps(gj, separators=(",", ":")), encoding="utf-8")
    log(f"  wrote {out_path.name}: {len(features)} precincts")
    return gj


# ------------------------------------------------------------------- results

def build_results(election):
    base = f"{RESULTS_API}/{COUNTY_SLUG}/{election['id']}/data"
    data = fetch_json(base)
    el = data["election"]

    precincts = {}
    for row in data.get("voterTurnout") or []:
        precincts[norm(row["precinctName"])] = {
            "registered": int(row.get("voterRegistration") or 0),
            "counted": int(row.get("ballotsCast") or 0),
        }

    contests = []
    for item in data.get("ballotItems") or []:
        options = item["summaryResults"]["ballotOptions"]
        option_ids = [o["id"] for o in options]
        contest = {
            "id": item["id"],
            "name": text(item["name"]),
            "type": item.get("contestType"),
            "total": item.get("voteTotal") or 0,
            "parentId": item.get("parentId"),
            "counties": len(item.get("crossCounties") or []),
            "options": [{"name": text(o["name"]), "party": (o.get("party") or {}).get("abbreviation"),
                         "votes": o.get("voteCount") or 0} for o in options],
            "precincts": {},
        }
        if el.get("includePrecinctResults"):
            detail = fetch_json(f"{base}/ballot-item/{item['id']}")
            breakdown = (detail.get("ballotItemWithBreakdown") or {}).get("breakdownResults") or []
            for row in breakdown:
                votes = {o["id"]: o.get("voteCount") or 0 for o in row["ballotOptions"]}
                contest["precincts"][norm(text(row["precinct"]["name"]))] = [votes.get(i, 0) for i in option_ids]
        contests.append(contest)

    reports = []
    for cat in el.get("publicReportCategories") or []:
        reports += [r["reportName"] for r in cat.get("reports") or []]

    summary = {
        "asOf": el.get("asOf"),
        "lastUpdated": el.get("lastUpdated"),
        "official": bool(el.get("isOfficialResults")),
        "hasPrecinctResults": bool(el.get("includePrecinctResults")),
        "ballotsCast": int(el.get("ballotsCast") or 0),
        "registered": sum(p["registered"] for p in precincts.values()),
        "url": f"https://results.votewa.gov/results/public/{COUNTY_SLUG}/elections/{election['id']}",
        "reports": reports,
    }
    return summary, precincts, contests


# ----------------------------------------------------------------- matchback

def download_matchback(election):
    url = election.get("matchback")
    if not url:
        return
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = resp.read()
            modified = resp.headers.get("Last-Modified")
    except Exception as exc:
        log(f"  ! matchback download failed ({exc!r}); using files already in data/matchback/")
        return

    text_head = body[:4096].decode("utf-8-sig", errors="replace")
    rows = list(csv.reader(io.StringIO(text_head)))
    if len(rows) < 2 or "Election" not in rows[0]:
        log("  ! matchback download isn't the expected CSV (bot check page?); skipping it")
        return
    found = norm(rows[1][rows[0].index("Election")])
    if found != norm(election["matchback_election"]):
        log(f"  ! matchback file is for '{found}', not '{election['matchback_election']}'; skipping it")
        return

    path = MATCHBACK / election["id"] / Path(url).name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    if modified:
        # Date the file by when the state published it, not when we fetched it.
        stamp = email.utils.parsedate_to_datetime(modified).timestamp()
        os.utime(path, (stamp, stamp))
    log(f"  downloaded matchback {path.name} ({len(body):,} bytes, published {modified})")


def latest_matchback(election_id):
    folder = MATCHBACK / election_id
    files = [p for p in folder.glob("*") if p.suffix.lower() in (".zip", ".csv", ".txt")]
    return max(files, key=lambda p: p.stat().st_mtime) if files else None


def iter_text_streams(path):
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as zf:
            for name in zf.namelist():
                if name.lower().endswith((".csv", ".txt")):
                    with zf.open(name) as raw:
                        yield name, io.TextIOWrapper(raw, encoding="utf-8-sig", errors="replace", newline="")
    else:
        with open(path, encoding="utf-8-sig", errors="replace", newline="") as fh:
            yield path.name, fh


def find_col(header, *needles, avoid=()):
    lowered = [h.lower().replace("_", "").replace(" ", "") for h in header]
    for needle in needles:
        for i, h in enumerate(lowered):
            if needle in h and not any(a in h for a in avoid):
                return i
    return None


def parse_date(value):
    value = (value or "").strip().split(" ")[0].split("T")[0]
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y"):
        try:
            return dt.datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    return None


def build_returns(election_id, boundaries):
    """Precinct return totals from the newest matchback file.

    The totals are saved to data/returns/<id>.json, which is committed, so builds
    on a machine without the matchback file reuse the last totals.
    """
    saved = RETURNS / f"{election_id}.json"
    path = latest_matchback(election_id)
    if not path:
        if saved.exists():
            stored = json.loads(saved.read_text(encoding="utf-8"))
            return stored["returns"], stored["precincts"]
        return {"available": False}, {}

    by_name = {f["properties"]["name"]: f["properties"]["name"] for f in boundaries["features"]}
    by_num = {str(f["properties"]["num"]): f["properties"]["name"] for f in boundaries["features"]}
    by_code = {f["properties"]["code"].upper(): f["properties"]["name"] for f in boundaries["features"]}

    counts = defaultdict(Counter)
    statuses = Counter()
    daily = Counter()
    methods = Counter()    # drop box / mail / email ...
    locations = Counter()  # which drop box or vote center
    unmatched = Counter()
    rows_seen = 0

    for member, stream in iter_text_streams(path):
        first = stream.readline()
        delim = max("|,\t", key=first.count)
        header = next(csv.reader([first], delimiter=delim))
        i_county = find_col(header, "countycode", "county")
        i_prec = find_col(header, "precinctname", "precinctcode", "precinct", avoid=("split",))
        i_status = find_col(header, "ballotstatus", "status", avoid=("voterstatus", "registration"))
        i_date = find_col(header, "receiveddate", "datereceived", "received")
        i_method = find_col(header, "returnmethod")
        i_location = find_col(header, "returnlocation")
        if i_prec is None:
            log(f"  ! {member}: no precinct column in header {header[:12]}...")
            continue
        for row in csv.reader(stream, delimiter=delim):
            rows_seen += 1
            if i_county is not None and len(row) > i_county and row[i_county].strip().upper() not in LEWIS_CODES:
                continue
            status = row[i_status].strip() if i_status is not None and len(row) > i_status else "Received"
            statuses[status] += 1
            if status.lower() in NOT_RETURNED:
                continue
            raw = row[i_prec].strip() if len(row) > i_prec else ""
            key = norm(raw)
            name = by_name.get(key) or by_code.get(key) or by_num.get(key.lstrip("0") or "0")
            if not name:
                unmatched[raw] += 1
                continue
            bucket = counts[name]
            bucket["returned"] += 1
            s = status.lower()
            if "accept" in s:
                bucket["accepted"] += 1
            elif "challeng" in s or "reject" in s or "cure" in s:
                bucket["challenged"] += 1
            if i_date is not None and len(row) > i_date:
                d = parse_date(row[i_date])
                if d:
                    daily[d.isoformat()] += 1
            if i_method is not None and len(row) > i_method:
                methods[row[i_method].strip() or "Unknown"] += 1
            if i_location is not None and len(row) > i_location and row[i_location].strip():
                locations[" ".join(row[i_location].split())] += 1

    if unmatched:
        log(f"  ! {sum(unmatched.values())} returned ballots had unmatched precincts, e.g. {list(unmatched)[:5]}")
    log(f"  matchback {path.name}: {rows_seen} rows read, statuses {dict(statuses.most_common(8))}")

    returns = {
        "available": True,
        "source": path.name,
        "fileTime": dt.datetime.fromtimestamp(path.stat().st_mtime, dt.timezone.utc).isoformat(),
        "returned": sum(c["returned"] for c in counts.values()),
        "accepted": sum(c["accepted"] for c in counts.values()),
        "challenged": sum(c["challenged"] for c in counts.values()),
        "unmatched": sum(unmatched.values()),
        "statusCounts": dict(statuses),
        "daily": sorted(daily.items()),
        "methods": dict(methods.most_common()),
        "locations": dict(locations.most_common()),
    }
    by_precinct = {name: dict(c) for name, c in counts.items()}
    RETURNS.mkdir(parents=True, exist_ok=True)
    saved.write_text(json.dumps({"returns": returns, "precincts": by_precinct}, indent=1), encoding="utf-8")
    return returns, by_precinct


# --------------------------------------------------------------------- build

def build_election(election):
    log(f"[{election['id']}] {election['name']}")
    boundaries = build_boundaries(election)
    summary, precincts, contests = build_results(election)
    download_matchback(election)
    returns, returned_by_precinct = build_returns(election["id"], boundaries)

    names = [f["properties"]["name"] for f in boundaries["features"]]
    missing = [n for n in names if n not in precincts]
    extra = [n for n in precincts if n not in set(names)]
    if missing or extra:
        log(f"  ! name mismatch - on map but not in results: {missing[:6]}; in results but not on map: {extra[:6]}")

    rows = {}
    for name in sorted(set(names) | set(precincts)):
        p = dict(precincts.get(name, {}))
        if returns["available"]:
            r = returned_by_precinct.get(name, {})
            p.update(returned=r.get("returned", 0), accepted=r.get("accepted", 0), challenged=r.get("challenged", 0))
        rows[name] = p

    out = {
        "id": election["id"],
        "name": election["name"],
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "results": summary,
        "returns": returns,
        "precincts": rows,
        "contests": contests,
    }
    (OUT / f"{election['id']}.json").write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    log(f"  results as of {summary['asOf']}; {summary['ballotsCast']} counted; "
        f"{len(contests)} contests; precinct results: {summary['hasPrecinctResults']}")


def build_all():
    OUT.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    built = []
    for election in ELECTIONS:
        try:
            build_election(election)
            built.append({"id": election["id"], "name": election["name"]})
        except Exception as exc:  # keep the last good file for this election
            log(f"  ! {election['id']} failed: {exc!r}")
            if (OUT / f"{election['id']}.json").exists():
                built.append({"id": election["id"], "name": election["name"]})
    (OUT / "elections.json").write_text(json.dumps(built, indent=1), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--watch", type=int, metavar="SECONDS", help="rebuild on this interval until stopped")
    args = ap.parse_args()
    while True:
        build_all()
        if not args.watch:
            break
        log(f"next build in {args.watch}s (Ctrl+C to stop)")
        time.sleep(args.watch)


if __name__ == "__main__":
    sys.exit(main())
