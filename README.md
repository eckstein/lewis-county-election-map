# Lewis County Election Map

An interactive map of Lewis County, WA showing three things by precinct:

- **Returned**: ballots returned, as a share of registered voters (from the state matchback file)
- **Counted**: ballots counted once results start (from the county results feed)
- **Results**: who leads each contest in each precinct, shaded by the size of the lead

## Running it

```bash
pip install -r requirements.txt
python scripts/build.py --watch 300
python -m http.server 8765 --directory site
```

Run the first two commands in one terminal and the server in another, then open http://localhost:8765. The build
reruns every 5 minutes, and the page picks up new data every 2 minutes without reloading.

## Data sources

| Layer | Source | Updates |
|---|---|---|
| Precinct boundaries | SOS statewide precinct shapefile (`Statewide_Precincts_2026General`), filtered to Lewis | Once per election (cached in `data/cache/`) |
| Registered voters, ballots counted, results | `results.votewa.gov` JSON feed: `/api/elections/lewis-county-wa/<id>/data` and `/data/ballot-item/<contest id>` for precinct results | Every count release on and after election night |
| Ballots returned | SOS Daily Ballot Status Report (matchback) | Each business day after 5 p.m. |

## Hosting

`.github/workflows/update-map.yml` runs every 15 minutes (and on every push to `main`). It rebuilds the data from the
county results feed and publishes `site/` to GitHub Pages. In the repo's Settings → Pages, set **Source** to
**GitHub Actions**. GitHub may start scheduled runs late when it's busy, and it pauses them after 60 days without
repo activity.

### Ballot returns (manual step)

The SOS page that links to the matchback file sits behind bot protection, so neither the local build nor the
GitHub Action can fetch it. Each day after 5 p.m.:

1. Download the Daily Ballot Status Report from
   https://www.sos.wa.gov/elections/data-research/election-data-and-maps/ballot-status-reports
2. Put the file (zip, csv or txt) in `data/matchback/20261103/`. The newest file there is used.
3. Run the build. It saves precinct totals (no voter-level data) to `data/returns/20261103.json`.
4. Commit and push that file. The hosted map picks it up within a few minutes.

```bash
python scripts/build.py
```

```bash
git add data/returns && git commit -m "Update ballot returns" && git push
```

The build finds the county, precinct, ballot status and received-date columns by name. It prints the status values
it saw and how many ballots it couldn't match to a precinct. Check that output the first time. The parser has only
been tested on a sample file in the expected layout, not a real SOS download.

Matchback files list individual voters. Their use is limited by RCW 29A.08.720/.740. The build writes only precinct
totals to `site/data/`, and `.gitignore` keeps the raw files out of git.

## Adding an election

Add an entry to `ELECTIONS` in `scripts/build.py` with the results-site election id (`YYYYMMDD`) and that election's
precinct shapefile URL from the SOS precinct shapefile page.

## Notes

- Some very small precincts have no precinct-level results in the feed (in the 2026 primary: Kelly, Mellen,
  Napavine #3, and others). They show as gray.
- Precinct names in the results feed match the shapefile's `PrecinctNa` field. The build warns if any don't match.
