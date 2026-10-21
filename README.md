# Lewis County Election Map

An interactive map of Lewis County, WA showing three things by precinct:

- **Returned**: ballots returned, as a share of registered voters (from the state matchback file)
- **Counted**: ballots counted once results start (from the county results feed)
- **Results**: who leads each contest in each precinct, shaded by the size of the lead

## How it updates

- **Results and ballots counted** load live in the viewer's browser from the county's `results.votewa.gov` feed. The
  page checks it every minute, and loads precinct results for the contest being viewed. The feed allows requests
  from any site (`Access-Control-Allow-Origin: *`), so no server or scheduled job is involved.
- **Ballot returns** are precinct totals in `site/data/<id>.json`, published once a day (see below). The page
  re-reads that file every 5 minutes.
- If the live feed can't be reached, the page falls back to the results snapshot saved in `site/data/` by the last
  build, and says so.

## Running it locally

```bash
pip install -r requirements.txt
```

```bash
python scripts/build.py
```

```bash
python -m http.server 8765 --directory site
```

Then open http://localhost:8765.

## Hosting

`.github/workflows/publish.yml` publishes `site/` to GitHub Pages on every push to `main`. In the repo's
Settings → Pages, set **Source** to **GitHub Actions**. Any other static host (Netlify, Cloudflare Pages) works the
same way: upload `site/`.

## Daily ballot returns

The SOS page that links to the matchback file sits behind bot protection, so this step is manual. Each day after
5 p.m.:

1. Download the Daily Ballot Status Report from
   https://www.sos.wa.gov/elections/data-research/election-data-and-maps/ballot-status-reports
2. Put the file (zip, csv or txt) in `data/matchback/20261103/`. The newest file there is used.
3. Run `python scripts/build.py`. It writes precinct totals (no voter-level data) to `site/data/20261103.json` and
   `data/returns/20261103.json`.
4. Commit and push:

```bash
git add site/data data/returns && git commit -m "Update ballot returns" && git push
```

The build finds the county, precinct, ballot status and received-date columns by name. It prints the status values
it saw and how many ballots it couldn't match to a precinct. Check that output the first time. The parser has only
been tested on a sample file in the expected layout, not a real SOS download.

Matchback files list individual voters. Their use is limited by RCW 29A.08.720/.740. Only precinct totals are
published, and `.gitignore` keeps the raw files out of git.

## Data sources

| Data | Source |
|---|---|
| Precinct boundaries | SOS statewide precinct shapefile for each election, filtered to Lewis (cached in `data/cache/`) |
| Registered voters, ballots counted, results | `https://results.votewa.gov/results/public/api/elections/lewis-county-wa/<id>/data`, plus `/data/ballot-item/<contest id>` for precinct results |
| Ballots returned | SOS Daily Ballot Status Report (matchback) |

## Adding an election

Add an entry to `ELECTIONS` in `scripts/build.py` with the results-site election id (`YYYYMMDD`) and that election's
precinct shapefile URL from the SOS precinct shapefile page, then run the build and push.

## Notes

- Some very small precincts have no precinct-level results in the feed (in the 2026 primary: Kelly, Mellen,
  Napavine #3, and others). They show as gray.
- Precinct names in the results feed match the shapefile's `PrecinctNa` field. The build warns if any don't match.
