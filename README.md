# Lewis County Election Map

An interactive map of Lewis County, WA with two views by precinct:

- **Ballots received**: ballots the county has received, as a share of registered voters (from the state matchback
  file)
- **Results**: who leads each contest in each precinct, shaded by the size of the lead

The countywide summary and each precinct's details card describe where ballots stand in a sentence and a bar:
counted, received but not yet counted, and not returned. Before 8 p.m. on Election Day nothing is counted, so they
show ballots received and when counting begins.

## How it updates

- **Results and ballots counted** load live in the viewer's browser from the county's `results.votewa.gov` feed. The
  page checks it on a schedule (below), and loads precinct results for the contest being viewed. The feed allows requests
  from any site (`Access-Control-Allow-Origin: *`), so no server or scheduled job is involved.
- **Multi-county contests** (statewide measures and races, legislative and congressional districts, the library
  district) show Lewis County's result next to the statewide or whole-district result in the summary panel. Those
  totals come from the state feed, loaded alongside the county one.
- **Ballot returns** are precinct totals in `site/data/<id>.json`, updated automatically from the state's daily
  file (see below), and read live through the Worker.
- If the live feed can't be reached, the page falls back to the results snapshot saved in `site/data/` by the last
  build, and says so.

### How often the page checks

The county and the state each post about once a day, so the page only checks often when something can change
(Pacific time):

| | Checks every |
|---|---|
| Results, election night (7:55 p.m. Election Day to 2 a.m.) | 1 minute |
| Results, Election Day before then | 5 minutes |
| Results, before Election Day | 15 minutes |
| Results, after election night until certified | 5 minutes |
| Results, once certified | 60 minutes |
| Ballot returns, 4:30-8 p.m. (the state posts around 5) | 5 minutes |
| Ballot returns, otherwise | 30 minutes |

A tab in the background skips checks (except results on election night, so its title can flag new results) and
catches up as soon as it's shown again. If the results feed can't be reached, it retries every 5 minutes.

## Results proxy (Cloudflare Worker)

The results.votewa.gov cache intermittently serves responses without the `Access-Control-Allow-Origin` header, and
the browser then blocks them. Sometimes this lasts a while: in testing, one feed failed 20 of 20 times in a row.
The page therefore fetches the feeds through a small Cloudflare Worker (`worker/`), at
`https://lc-results-proxy.zacharyeckstein.workers.dev`. It fetches the feed server-side and always adds the
header. It only passes through the three feed paths the map uses, plus `/geocode?address=`, which forwards
"find my precinct" searches to the U.S. Census Bureau geocoder (no CORS header there either) without caching or
logging them, and `/returns/<id>`, which serves live ballot-return totals (see below). If the Worker fails, the page goes to the feed
directly, with retries.

To change and redeploy the Worker:

```bash
cd worker && npx wrangler@4 deploy
```

The Cloudflare account is on the Workers Paid plan (10 million requests a month included). Each open copy of the
map makes about 4-8 requests an hour, and 1-2 a minute on election night.
Workers Caching is on (`[cache]` in `wrangler.toml`), so repeat requests are answered from Cloudflare's cache and
the county and state sites see about one request per cache period, however many maps are open. If the Worker ever fails, the map falls back to the direct feed.

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
`https://www.sos.wa.gov/sites/default/files/current_election/Lewis.csv`, updated each business day around 5 p.m.

The map reads it live through the Worker: `/returns/20261103` downloads the file, checks its `Election` column,
and returns only totals (by precinct, received date, return method and drop box), cached for 5 minutes. The page
checks every 5 minutes from 4:30 to 8 p.m., so a new file shows up within about 10 minutes of the state posting it. The election id,
URL and expected `Election` value are in `MATCHBACK` at the top of `worker/src/index.js`.

GitHub's hourly schedule is unreliable (some days it runs only every few hours), so the workflow below is now the
fallback and the record of each day's totals in git. The page uses whichever totals come from the newer file.
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
election, move the `matchback` and `matchback_election` keys to its entry, matching the file's `Election` column,
and change `MATCHBACK` in `worker/src/index.js` the same way, then redeploy the Worker.

## Notes

- Some very small precincts have no precinct-level results in the feed (in the 2026 primary: Kelly, Mellen,
  Napavine #3, and others). They show as gray.
- Precinct names in the results feed match the shapefile's `PrecinctNa` field. The build warns if any don't match.
