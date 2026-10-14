# Rentals Watch (Yad2)

A public page that tracks one Yad2 search, refreshes every ~30 minutes, shows when it was last updated, and highlights new listings and price drops. No login needed to view.

## Setup (≈5 minutes, once)

1. **Create a repo** on GitHub: New repository → name it e.g. `rentals-watch` → **Public** → Create.
2. **Upload the files**: on the empty repo page click *uploading an existing file*, drag in everything from this folder **including the hidden `.github` folder** (on Mac press `Cmd+Shift+.` in Finder to show it), then *Commit changes*.
   - If the `.github` folder won't drag: *Add file → Create new file*, name it `.github/workflows/update.yml`, paste the contents of that file, commit.
3. **Turn on Pages**: repo *Settings → Pages → Build and deployment → Source: **GitHub Actions***.
4. **Run it once**: *Actions* tab → *Update listings* → *Run workflow*. After ~1 minute the page is live at
   `https://<your-github-username>.github.io/rentals-watch/`
   That's the link to share.

## Using it

- **Refresh** reloads the newest snapshot. The page also re-checks by itself every 5 minutes while open.
- **Check Yad2 now** (owner only) opens the workflow page; click *Run workflow* to fetch immediately instead of waiting for the next 30-minute run.
- **NEW** = appeared since you clicked *Mark all seen* in that browser (first-time visitors: last 48 hours). Listings present on the very first run are not marked new.
- Removed listings stay in a collapsed section for 7 days. Price changes show as ↓/↑ badges.

## Changing the search or area

Set the filters and map area on Yad2, copy the browser URL, and paste it as `searchUrl` in `config.json` (edit on GitHub → Commit). The next run uses it.
If you move to a different Yad2 region, also set `"region"` (coastal-north = 5).

Only listings inside the map box and within your price/room limits are kept — promoted ads from outside the area are dropped.

## If it says "Blocked by Yad2 bot protection"

Yad2 sometimes blocks cloud servers. The page keeps showing the last good results and the banner tells you. If it keeps happening, reduce the schedule in `.github/workflows/update.yml` (e.g. `"0 * * * *"` for hourly).

Note: GitHub pauses scheduled workflows after 60 days without repo activity — click *Enable workflow* in Actions if that happens.
