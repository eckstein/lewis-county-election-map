"""Precinct ballot-return totals for every precinct in CD 3, LD 19 and LD 20.

Run from the repo root: python analysis/district_returns.py
Needs network access to sos.wa.gov and results.votewa.gov. Writes only precinct
totals to analysis/district_returns.csv (plus per-county notes in
district_returns_meta.json); the voter-level files are read in memory and never saved.
"""

import csv
import io
import json
import re
import sys
import urllib.request
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import shapefile

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from build import ELECTIONS, NOT_RETURNED, find_col, norm  # noqa: E402

SOS = "https://www.sos.wa.gov/sites/default/files/current_election"
FEED = "https://results.votewa.gov/results/public/api/elections"
UA = {"User-Agent": "lewis-county-election-map (github.com/eckstein/lewis-county-election-map)"}
OUT = Path(__file__).resolve().parent / "district_returns.csv"
META = Path(__file__).resolve().parent / "district_returns_meta.json"
FILES = {"Grays Harbor": "Grays_Harbor", "San Juan": "San_Juan", "Pend Oreille": "PendOreille",
         "Walla Walla": "WallaWalla"}


def fetch(url, timeout=300):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read(), resp.headers.get("Last-Modified")


def main():
    body, _ = fetch(ELECTIONS[0]["shapefile"])
    with zipfile.ZipFile(io.BytesIO(body)) as zf:
        stem = next(Path(n).stem for n in zf.namelist() if n.lower().endswith(".shp"))
        reader = shapefile.Reader(dbf=io.BytesIO(zf.read(f"{stem}.dbf")))
    precincts = defaultdict(dict)  # county -> st_code -> record
    for rec in reader.iterRecords():
        r = rec.as_dict()
        cd, ld = int(r["CD"] or 0), int(r["LD"] or 0)
        if cd == 3 or ld in (19, 20):
            county = str(r["CountyName"]).strip()
            precincts[county][r["St_Code"]] = {"county": county, "st_code": r["St_Code"],
                                              "name": norm(r["PrecinctNa"]), "num": str(r["PrecinctNu"]),
                                              "cd": cd, "ld": ld, "registered": 0, "returned": 0}
    meta = {}
    for county, recs in sorted(precincts.items()):
        by_name = {p["name"]: p for p in recs.values()}
        by_code = {k.upper(): p for k, p in recs.items()}
        by_num = {p["num"].lstrip("0") or "0": p for p in recs.values()}
        info = meta[county] = {"precincts": len(recs)}

        # Ballots returned, from the state's daily file.
        body, modified = fetch(f"{SOS}/{FILES.get(county, county)}.csv")
        info["fileModified"] = modified
        stream = io.StringIO(body.decode("utf-8-sig", errors="replace"))
        first = stream.readline()
        delim = max("|,\t", key=first.count)
        header = next(csv.reader([first], delimiter=delim))
        i_prec = find_col(header, "precinctname", "precinctcode", "precinct", avoid=("split",))
        i_status = find_col(header, "ballotstatus", "status", avoid=("voterstatus", "registration"))
        i_date = find_col(header, "receiveddate", "datereceived", "received")
        statuses, unmatched, daily = Counter(), Counter(), Counter()
        for row in csv.reader(stream, delimiter=delim):
            status = row[i_status].strip() if i_status is not None and len(row) > i_status else "Received"
            statuses[status] += 1
            if status.lower() in NOT_RETURNED:
                continue
            key = norm(row[i_prec]) if len(row) > i_prec else ""
            p = by_name.get(key) or by_code.get(key) or by_num.get(key.lstrip("0") or "0")
            if p:
                p["returned"] += 1
                if i_date is not None and len(row) > i_date:
                    daily[(row[i_date].strip().split(" ")[0], p["ld"], p["cd"])] += 1
            else:
                unmatched[key] += 1
        info["statuses"] = dict(statuses)
        info["unmatched"] = sum(unmatched.values())
        info["unmatchedExamples"] = list(unmatched)[:5]
        info["daily"] = [[d, ld, cd, n] for (d, ld, cd), n in sorted(daily.items())]
        del body, stream

        # Registered voters, from the county results feed's turnout list.
        slug = county.lower().replace(" ", "-") + "-county-wa"
        feed = json.loads(fetch(f"{FEED}/{slug}/20261103/data", 120)[0])
        reg_unmatched = 0
        for row in feed.get("voterTurnout") or []:
            name = norm(row["precinctName"])
            p = by_name.get(name) or by_name.get(name.split(" - ")[0]) or by_code.get(name)
            if not p:
                lead = re.match(r"0*(\d+)", name)
                trail = re.search(r"0*(\d+)\s*$", name)
                p = (lead and by_num.get(lead.group(1))) or (trail and by_num.get(trail.group(1)))
            if p:
                p["registered"] += int(row.get("voterRegistration") or 0)
            else:
                reg_unmatched += int(row.get("voterRegistration") or 0)
        info["registeredUnmatched"] = reg_unmatched
        info["feedRegistered"] = sum(int(r.get("voterRegistration") or 0) for r in feed.get("voterTurnout") or [])
        print(county, info["precincts"], "returned", sum(p["returned"] for p in recs.values()),
              "unmatched", info["unmatched"], "reg unmatched", reg_unmatched, flush=True)

    with open(OUT, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["county", "st_code", "name", "num", "cd", "ld", "registered", "returned"])
        w.writeheader()
        for recs in precincts.values():
            w.writerows(sorted(recs.values(), key=lambda p: p["st_code"]))
    META.write_text(json.dumps(meta, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
