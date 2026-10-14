// Yad2 rentals watcher.
//
// Yad2's bot filter lets a cloud machine make about one request before it starts demanding a captcha,
// so the workflow splits each search into map tiles and fetches every tile from its own runner (one
// request each, via Yad2's map endpoint, which returns up to 200 full listings per call).
//
//   node scripts/fetch.mjs --plan                      -> prints the tile list (JSON) for the workflow matrix
//   node scripts/fetch.mjs <prev.json> <out.json> <partsDir>
//        partsDir holds one folder per tile with part.json (Yad2 response) and status.txt (HTTP code)
import fs from 'node:fs';
import path from 'node:path';

const cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'config.json'), 'utf8'));
const now = new Date().toISOString();
const DAY = 864e5;
const CAP = 200; // Yad2's map endpoint returns at most this many listings per call

// Yad2 region slug (from the search URL) -> region id the API needs.
// Other ids: 2 south, 3 Tel Aviv area, 4 Judea & Samaria, 6 Jerusalem area, 7 north & valleys.
const REGION_SLUGS = { 'center-and-sharon': 1, 'coastal-north': 5 };

const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };

function searches() {
  return (cfg.searches || []).map((s, si) => {
    const u = new URL(s.url);
    const parts = u.pathname.split('/').filter(Boolean); // realestate / rent / center-and-sharon
    const deal = parts[1] || 'rent';
    const slug = parts[2] || '';
    const params = new URLSearchParams(u.searchParams);
    params.delete('zoom');
    const region = s.region ?? REGION_SLUGS[slug];
    if (region) params.set('region', String(region));
    if (!params.has('region')) throw new Error(`Unknown region for "${slug}" - add "region" to that search in config.json`);
    const urlBox = params.get('bBox');
    params.delete('bBox');
    const tiles = (s.tiles?.length ? s.tiles : [urlBox || '29,34,34,36']).map((box, ti) => {
      const q = new URLSearchParams(params);
      q.set('bBox', box);
      return {
        id: `s${si}t${ti}`,
        box: box.split(',').map(Number),
        url: `https://gw.yad2.co.il/realestate-feed/${deal}/map?${q.toString().replace(/%2C/gi, ',')}`,
      };
    });
    const num = k => (params.has(k) ? Number(params.get(k)) : null);
    return {
      name: s.name || slug, url: s.url, slug, tiles,
      f: { minPrice: num('minPrice'), maxPrice: num('maxPrice'), minRooms: num('minRooms'), maxRooms: num('maxRooms') },
    };
  });
}

const inBox = (l, [a1, o1, a2, o2]) => l.lat != null && l.lon != null &&
  l.lat >= Math.min(a1, a2) && l.lat <= Math.max(a1, a2) && l.lon >= Math.min(o1, o2) && l.lon <= Math.max(o1, o2);

function matches(it, f) {
  if (f.maxPrice != null && !(it.price <= f.maxPrice)) return false;
  if (f.minPrice != null && !(it.price >= f.minPrice)) return false;
  if (f.minRooms != null && !(it.rooms >= f.minRooms)) return false;
  if (f.maxRooms != null && !(it.rooms <= f.maxRooms)) return false;
  return true;
}

function normalize(raw, slug, fallbackRegion) {
  const a = raw.address || {}, d = raw.additionalDetails || {}, m = raw.metaData || {};
  const tags = (raw.tags || []).map(t => (typeof t === 'string' ? t : t?.name || t?.text)).filter(Boolean);
  return {
    id: raw.token,
    url: `https://www.yad2.co.il/realestate/item/${slug ? slug + '/' : ''}${raw.token}`,
    price: raw.price ?? null,
    rooms: d.roomsCount ?? null,
    sqm: m.squareMeterBuild || d.squareMeter || null, // built area; squareMeter can include garden/plot
    floor: a.house?.floor ?? null,
    property: d.property?.text || '',
    region: a.region?.text || fallbackRegion,
    area: a.area?.text || '',
    city: a.city?.text || '',
    neighborhood: a.neighborhood?.text || '',
    street: [a.street?.text, a.house?.number].filter(Boolean).join(' '),
    lat: a.coords?.lat ?? null,
    lon: a.coords?.lon ?? null,
    image: m.coverImage || null,
    images: Array.isArray(m.images) ? m.images.length : 0,
    seller: raw.adType === 'private' ? 'private' : 'agency',
    agency: raw.customer?.agencyName || '',
    tags,
  };
}

function readPart(partsDir, id) {
  const dir = path.join(partsDir, `part-${id}`);
  const status = (fs.existsSync(path.join(dir, 'status.txt')) ? fs.readFileSync(path.join(dir, 'status.txt'), 'utf8') : 'missing').trim();
  if (status !== '200') return { error: status === '302' || status === '403' ? `blocked by Yad2 (HTTP ${status})` : `HTTP ${status}` };
  const json = readJson(path.join(dir, 'part.json'), null);
  const markers = json?.data?.markers;
  if (!Array.isArray(markers)) return { error: 'unexpected response' };
  return { markers };
}

function main() {
  if (process.argv[2] === '--plan') {
    console.log(JSON.stringify(searches().flatMap(s => s.tiles.map(t => ({ id: t.id, url: t.url })))));
    return;
  }
  const [prevPath, outPath, partsDir] = process.argv.slice(2);
  const prev = readJson(prevPath, {});
  const prevList = Array.isArray(prev.listings) ? prev.listings : [];
  const ss = searches();

  // 1. Collect this run's listings, tile by tile.
  const byId = new Map(), failedTiles = [], capped = [];
  for (const s of ss) {
    for (const t of s.tiles) {
      const r = readPart(partsDir, t.id);
      if (r.error) { failedTiles.push({ ...t, search: s, error: r.error }); continue; }
      if (r.markers.length >= CAP) capped.push(`${s.name} tile ${t.id}`);
      for (const raw of r.markers) {
        if (!raw?.token) continue;
        const it = normalize(raw, s.slug, s.name);
        if (matches(it, s.f)) byId.set(it.id, it);
      }
    }
  }
  const totalTiles = ss.reduce((n, s) => n + s.tiles.length, 0);
  const base = {
    title: cfg.title,
    newWindowHours: cfg.newWindowHours ?? 48,
    firstRunAt: prev.firstRunAt || now,
    lastAttemptAt: now,
    searches: ss.map(s => ({ name: s.name, url: s.url })),
  };
  const write = out => { fs.mkdirSync(path.dirname(outPath), { recursive: true }); fs.writeFileSync(outPath, JSON.stringify(out, null, 1)); };

  if (failedTiles.length === totalTiles) {
    write({ ...prev, ...base, updatedAt: prev.updatedAt || null, status: 'error',
      error: `All ${totalTiles} Yad2 requests failed (${failedTiles[0].error}). Will retry on the next run.`, listings: prevList });
    console.error('All tiles failed');
    return;
  }

  // 2. Merge with the previous snapshot.
  const searchKey = ss.map(s => s.tiles.map(t => t.url).join(' ')).join(' | ');
  const searchChanged = prevList.length > 0 && prev.searchKey !== searchKey;
  const isBaseline = (prevList.length === 0 && !prev.updatedAt) || searchChanged;
  const inFailedTile = l => failedTiles.some(t => inBox(l, t.box) && (!l.region || l.region === t.search.name || !ss.some(s => s.name === l.region)));
  const prevById = new Map(prevList.map(l => [l.id, l]));
  const listings = [];
  for (const it of byId.values()) {
    const old = prevById.get(it.id);
    const history = old?.priceHistory ? [...old.priceHistory] : [{ price: it.price, at: now }];
    if (old && old.price !== it.price) history.push({ price: it.price, at: now });
    listings.push({
      ...it,
      firstSeen: old?.firstSeen || now,
      initial: old ? !!old.initial : isBaseline, // there when tracking (or this search) started -> not "new"
      lastSeen: now, active: true, priceHistory: history.slice(-10),
    });
  }
  const keepMs = (cfg.keepRemovedDays ?? 7) * DAY;
  for (const old of prevList) {
    if (byId.has(old.id) || searchChanged) continue;
    if (old.active !== false && inFailedTile(old)) { listings.push(old); continue; } // tile not fetched this run: keep as is
    const removedAt = old.active === false ? old.removedAt : now;
    if (Date.now() - new Date(removedAt).getTime() > keepMs) continue;
    listings.push({ ...old, active: false, removedAt });
  }

  const warnings = [];
  if (failedTiles.length) warnings.push(`${failedTiles.length} of ${totalTiles} map areas couldn't be fetched this run (${failedTiles[0].error}); their listings are from the previous run.`);
  if (capped.length) warnings.push(`Some map areas hit Yad2's 200-listing limit (${capped.join(', ')}) - split them into smaller tiles in config.json.`);
  write({
    ...base, updatedAt: now, status: failedTiles.length ? 'partial' : 'ok', error: null, warning: warnings.join(' ') || null,
    count: listings.filter(l => l.active).length, searchKey, listings,
  });
  const fresh = listings.filter(l => l.active && !l.initial && l.firstSeen === now).length;
  console.log(`OK: ${byId.size} fetched, ${fresh} new, ${failedTiles.length}/${totalTiles} tiles failed${searchChanged ? ' (search changed - new baseline)' : ''}`);
}

main();
