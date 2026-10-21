# Lewis County Election Map

An interactive map of Lewis County, WA showing three things by precinct:

- **Returned**: ballots returned, as a share of registered voters (from the state matchback file)
- **Counted**: ballots counted once results start (from the county results feed)
- **Results**: who leads each contest in each precinct, shaded by the size of the lead

## How it updates

- **Results and ballots counted** load live in the viewer's browser from the county's `results.votewa.gov` feed. The
  page checks it every minute, and loads precinct results for the contest being viewed. The feed allows requests
  from any site (`Access-Control-Allow-Origin: *`), so no server or scheduled job is involved.
- **Multi-county contests** (statewide measures and races, legislative and congressional districts, the library
  district) show Lewis County's result next to the statewide or whole-district result in the summary panel. Those
  totals come from the state feed, loaded alongside the county one.
- **Ballot returns** are precinct totals in `site/data/<id>.json`, updated automatically from the state's daily
  file (see below). The page re-reads that file every 5 minutes.
- If the live feed can't be reached, the page falls back to the results snapshot saved in `site/data/` by the last
  build, and says so.

## Results proxy (Cloudflare Worker)

The results.votewa.gov cache intermittently serves responses without the `Access-Control-Allow-Origin` header, and
the browser then blocks them. Sometimes this lasts a while: in testing, one feed failed 20 of 20 times in a row.
The page therefore fetches the feeds through a small Cloudflare Worker (`worker/`), at
`https://lc-results-proxy.zacharyeckstein.workers.dev`. It fetches the feed server-side and always adds the
header. It only passes through the three feed paths the map uses. If the Worker fails, the page goes to the feed
directly, with retries.

To change and redeploy the Worker:

```bash
cd worker && npx wrangler@4 deploy
```

Cloudflare's free plan allows 100,000 Worker requests a day. Each open copy of the map makes about 2-3 a minute.
If the limit is reached, the map falls back to the direct feed until the daily reset.

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

`.github/workflows/publish.yml` publishes `site/` to GitHub Pages on every push to `main`, and also runs every hour
to pick up new ballot returns. Pages is set to deploy from **GitHub Actions** (Settings → Pages).

## Daily ballot returns

The Secretary of State posts each county's Daily Ballot Status Report (matchback) at a fixed URL, for Lewis
`https://www.sos.wa.gov/sites/default/files/current_election/Lewis.csv`, updated each business day after 5 p.m.
Every hour the workflow:

1. Downloads that file and checks its `Election` column says `General Nov 3 2026`. The URL always holds the
   *current* election, so after this one the check stops it from mixing in the next election's data.
2. Totals ballots by precinct into `data/returns/20261103.json` and `site/data/20261103.json`.
3. If the totals changed, it commits them and republishes the map.

Running `python scripts/build.py` locally does the same download. A file dropped into `data/matchback/20261103/` by
hand is used too: the newest file there wins.

Statuses in the file are `Accepted` and `Rejected` (rejected ballots carry a challenge reason, such as a signature
mismatch, and can still be cured); the map counts rejected ballots as "Challenged". The build prints the status
values it saw and how many ballots it couldn't match to a precinct.

Matchback files list individual voters. Their use is limited by RCW 29A.08.720/.740. Only precinct totals are
published, and `.gitignore` keeps the raw files out of git.

## Data sources

| Data | Source |
|---|---|
| Precinct boundaries | SOS statewide precinct shapefile for each election, filtered to Lewis (cached in `data/cache/`) |
| Registered voters, ballots counted, results | `https://results.votewa.gov/results/public/api/elections/lewis-county-wa/<id>/data`, plus `/data/ballot-item/<contest id>` for precinct results |
| Statewide / whole-district totals for multi-county contests | `https://results.votewa.gov/results/public/api/elections/washington/<id>/data`, matched to Lewis contests by their `parentId` and to candidates by name |
| Ballots returned | SOS Daily Ballot Status Report (matchback): `https://www.sos.wa.gov/sites/default/files/current_election/Lewis.csv` |

## Adding an election

Add an entry to `ELECTIONS` in `scripts/build.py` with the results-site election id (`YYYYMMDD`) and that election's
precinct shapefile URL from the SOS precinct shapefile page, then run the build and push. For the new current
election, move the `matchback` and `matchback_election` keys to its entry, matching the file's `Election` column.

## Notes

- Some very small precincts have no precinct-level results in the feed (in the 2026 primary: Kelly, Mellen,
  Napavine #3, and others). They show as gray.
- Precinct names in the results feed match the shapefile's `PrecinctNa` field. The build warns if any don't match.
