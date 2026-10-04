# StyleDNA daily run

Keeps style tags on every active single-family listing in the quiz areas, reads new front photos
with Claude, and puts each new quiz lead's top matches in their Lofty note.

Josh is not a coder. Every message to him is plain English, no em dashes, short.

## Where things live

- Code: this repo (`jwaters112/ChloeIQ-StyleDNA`, branch `quick-fixes`). If the session has no
  checkout, attach it with `add_repo` (owner `jwaters112`, repo `ChloeIQ-StyleDNA`), clone it and
  check out `quick-fixes`.
- Data (MLS data, never commit it): on Josh's Mac in `~/Downloads/StyleDNA/`
  - `data/photo_styles.csv`: every photo read so far (the asset that grows each day). Never lose it.
  - `data/tags.csv`: yesterday's tags, for reference.
  - `exports/<DATE>/`: that day's Matrix exports.
  - `runs/<DATE>.txt`: the run summary.
- Photo tagging page (preview site, needs Josh's Vercel sign-in, which his Chrome has):
  `https://homestyledna-git-quick-fixes-dallas-collective-group.vercel.app/tag-test.html`
  The Claude API key lives in Vercel (`ANTHROPIC_API_KEY`); never ask for it or paste it.
- Browser snippets: `tools/matrix_snippets.js`.

## Stop conditions (push Josh one short note, then end the run)

- His Mac is not reachable, or `~/Downloads` is not available.
- Matrix is logged out in Chrome (never touch a login form).
- The tagging page returns `api_400`/`api_402`/credit or billing errors: the Claude Console is out
  of credits. Say so: "StyleDNA paused photo reads: the Claude account needs more credits."
- An export comes back with fewer than 50% of the rows the search showed.

## Steps

`DATE` = today in America/Chicago, `YYYY-MM-DD`.

### 1. Pre-flight
- `get_device_info`: Mac linked, `~/Downloads` connected.
- Claude in Chrome: open a tab on `https://ntrdd.mlsmatrix.com/Matrix/` and confirm "Hello, Josh".
  If calls fail with "tab not in group", another Claude side panel is open: tell Josh once.
- Do not close tabs during the run (closing a tab has broken the tab group before).

### 2. Matrix export, all quiz areas (about 10 minutes)
Open `https://ntrdd.mlsmatrix.com/Matrix/Search/Residential/Detailed`.

City field: take a screenshot first (brings the tab forward), click the City box at about
(600, 500), then for each city type the name, wait 2 seconds, press Return. Verify with
`document.querySelectorAll('.select2-search-choice').length` = 55 (2 states + 53 cities).

Cities (53): Highland Park, University Park, Westover Hills, Southlake, Westlake, Colleyville,
Grapevine, Trophy Club, Roanoke, Keller, Bedford, Euless, Hurst, North Richland Hills, Flower Mound,
Highland Village, Lewisville, Argyle, Bartonville, Copper Canyon, Double Oak, Lantana, Denton,
Corinth, Little Elm, The Colony, Aubrey, Frisco, Prosper, Celina, McKinney, Plano, Allen, Fairview,
Anna, Melissa, Wylie, Coppell, Carrollton, Richardson, Garland, Mesquite, Rockwall, Heath, Rowlett,
Sachse, Murphy, Irving, Arlington, Mansfield, Aledo, Willow Park, Burleson.

Then by JavaScript: untick the status boxes for Active Contingent, Active KO and Active Option
Contract (the status checkboxes are the inputs whose id contains `Ctrl18`; keep only Active),
and set Property Sub Type `Fm23_Ctrl105_LB` to Single Family Residence only.

Export each price band (`Fm23_Ctrl53_TB`, in thousands): `1000+`, `750-1000`, `500-750`,
`350-500`, `0-350`. For each band:
1. Set the price, run `__doPostBack('m_ucSearchButtons$m_lbSearch','')`, note "1-100 of N".
2. `m_lnkCheckAllLink.click()`, confirm "Checked N".
3. `__doPostBack('m_lbExport','')`, set `m_ddExport` to `ug121597`
   (Export for Chloe Data - Active Listings), click `m_btnExport`. Wait 10 seconds.
4. Return with `m_btnBack` (Back to Results), then `__doPostBack('m_ucResultsPageTabs$m_lbSearchTab','')`.
   Never use the browser Back button here: it wipes the city list (cost a bad export on 3 Oct).
   Confirm the 55 chips are still there before the next band.

If one band shows more than 4,500, split it in two (for example `350-425` and `425-500`).

Then the in-town neighbourhoods: open a fresh Detailed search, leave City empty, put these ZIPs in
`Fm23_Ctrl60_TextBox`, same status and sub-type settings, no price, and export the same way:
`75201,75202,75204,75205,75206,75208,75209,75211,75214,75219,75224,75225,75226,75229,75230,75238,75243,76102,76104,76107,76109,76110`

Each export lands in `~/Downloads` as `Export for Chloe Data - Active Listings (n).csv`. Move them
with `device_bash` into `~/Downloads/StyleDNA/exports/DATE/` named `price-1m-plus.csv`,
`price-750k-1m.csv`, `price-500k-750k.csv`, `price-350k-500k.csv`, `price-under-350k.csv`,
`neighborhood-zips.csv`. Check each file's row count against the search count. On 3 Oct 2026 the
total was 14,468.

### 3. Rebuild the active list and find photos to read (cloud)
Stage the six exports, `data/photo_styles.csv` and `data/active_mls.txt` into the session, then:
```
python3 tools/styledna_daily.py merge-export WORK exports/*.csv --full
cp photo_styles.csv WORK/
python3 tools/styledna_daily.py todo-photos WORK --max 1500 > todo.txt
```
`merge-export` also writes `WORK/new_today.txt`: listings that weren't active yesterday. It
compares against `active_mls.txt` (yesterday's MLS numbers, small enough to keep on the Mac):
stage `data/active_mls.txt` into `WORK` before merging, and copy the updated one back in step 5.
With no previous list, nothing counts as new that day. `todo-photos` puts today's new
listings first so their buyers can get alerts the same morning.

`todo.txt` has one line per batch of 51 MLS numbers. Up to 1,500 a day while the backlog lasts
(about 13,300 on 3 Oct 2026, so roughly nine mornings), then just the new listings.

### 4. Photo reads (about 1 minute per 100 homes)
For each pair of lines in `todo.txt` (about 100 homes):
1. On the Detailed search form put the MLS numbers in `Fm23_Ctrl54_TextBox` (51 max per search,
   500-character limit), run the search, switch the display `m_ucDisplayPicker_m_ddlDisplayFormats`
   to `31` (Customer Brief, 10 per page). Clear `sessionStorage.sdna_h` before the first page.
2. On each results page run `collectPage()` from `tools/matrix_snippets.js`; page with
   `__doPostBack('m_DisplayCore','Redisplay|,,OFFSET')` for OFFSET 10, 20, ... Repeat for the
   second line of MLS numbers.
3. Read the ZIPs with `readZips(0)`, `readZips(80)` ... and save them as `{mls: zip}`.
4. Run `sendToTagger()`. The Matrix tab becomes the tagging page. Wait about 30 seconds per 100,
   until the page says "Done". Read results with `readResults(0)`, `readResults(50)`.
   Photo links expire within the hour, so always send right after collecting.
5. Navigate back to the Matrix Detailed search for the next batch.
Save all results as a JSON list of `{mls, ext, int}` and the ZIPs as JSON, then:
```
python3 tools/styledna_daily.py merge-photos WORK results.json --zips zips.json
```
If a batch shows `photo_` errors, those homes retry tomorrow automatically.

### 5. Tag everything (cloud, about 1 minute)
```
python3 tools/styledna_daily.py tag WORK
```
Copy `WORK/photo_styles.csv`, `WORK/active_mls.txt` and `WORK/tags.csv` back to `~/Downloads/StyleDNA/data/` with
`device_commit_files` (files over about 25 MB fail to commit; tags.csv is about 25 MB, so if it
fails, skip it: photo_styles.csv is the one that matters).

### 5b. New listings to home boards (alerts)
Home boards are private shared boards buyers start from their quiz result. Each morning, new
listings that fit a board go onto it as "Josh's picks" and its members get one phone alert.
1. In Chrome, open any page on the preview site (the tagging page is fine). Run `adminList()`
   from `tools/matrix_snippets.js`, then `adminListChunk(0)`, `adminListChunk(900)` ... until empty.
   Join the chunks and save as `WORK/boards.json`.
2. `python3 tools/styledna_daily.py board-picks WORK WORK/boards.json WORK/picks.json`
3. If `picks.json` isn't empty, run `postPicks(<contents of picks.json>)` on the preview page.
   It returns `boardId:added` for each board. Never post picks to a board twice in one day.
4. Boards for townhome, condo or land buyers are skipped for now (tags cover single family only).
Report the count in the wrap-up: "3 boards got new listings, 4 alerts sent".

### 6. Matches for new quiz leads (Lofty connector, no Mac needed)
- `search_leads` with `filters: {anyTags: ["StyleDNA Quiz"]}`, newest first, created in the last
  14 days. If Lofty answers "tags ... by name not found", no quiz lead exists yet (the quiz is not
  live until Josh approves it): skip this step and say "no quiz leads yet".
- For each lead, `search_lead_activities` for its notes. Skip the lead if a note already starts
  with "StyleDNA matches for".
- Build the lead record: archetype from the tag `StyleDNA: <name>`, area from the `Area: <name>` tags
  (a lead can have several; pass them as a list, e.g. `"area": ["Frisco", "Southlake"]`),
  price from the lead's inquiry `priceMin` / `priceMax` (or the `Budget:` tag).
- Tags only cover single-family homes for now. If the lead has a `Home type:` tag of Townhome,
  Condo or Land, skip the matches and add a one-line note instead: "StyleDNA: wants <type>, no
  style-tagged <type> listings yet. Their joshwaters.com link is filtered to <type>."
- If the note has an `In their words:` line, keep it in mind when checking the matches.
- If the note has a `Home board:` link, the buyer also gets new listings on their board (step 5b).
- `python3 tools/styledna_match.py WORK/tags.csv leads.json matches.json`
- For each match line, swap the search link for the home's own page: WebFetch the search link and
  take the `https://joshwaters.com/listing-detail/...` link whose address matches. Keep the search
  link if none matches.
- `manage_leads` action `add_note`, `lead_id`, `fields: {content: <note>}`. Never text or email
  the lead; Josh reviews and sends.

### 7. Wrap up
Write `runs/DATE.txt` on the Mac and push Josh a short note:
"StyleDNA: 14,468 active homes, 1,500 new photo reads (11,766 left), 2 new quiz leads got matches
in Lofty." Use the real numbers, and say if anything stopped early and why.
