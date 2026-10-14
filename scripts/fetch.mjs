// Pulls the Yad2 searches in config.json and merges them with the previous snapshot.
// Usage: node scripts/fetch.mjs <prev.json> <out.json>
// Test mode: FEED_FIXTURE=dir  -> reads <searchIndex>-page-<n>.json instead of calling Yad2.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const COOKIE_JAR = path.join(os.tmpdir(), 'yad2-cookies.txt');

const [prevPath, outPath] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'config.json'), 'utf8'));
const now = new Date().toISOString();
const DAY = 864e5;

// Yad2 region slug (from the search URL) -> region id the API needs.
// Other region ids: 2 south, 3 Tel Aviv area, 4 Judea & Samaria, 6 Jerusalem area, 7 north & valleys
// (set "region" on the search in config.json if its slug isn't listed here).
const REGION_SLUGS = { 'center-and-sharon': 1, 'coastal-north': 5 };
const BUCKETS = ['private', 'agency', 'platinum', 'leadingBroker', 'kingOfTheHar', 'trio', 'booster'];

const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function searchesFromConfig() {
  const list = cfg.searches || (cfg.searchUrl ? [{ name: '', url: cfg.searchUrl, region: cfg.region }] : []);
  if (!list.length) throw new Error('No searches in config.json');
  return list.map(s => {
    const u = new URL(s.url);
    const parts = u.pathname.split('/').filter(Boolean); // realestate / rent / center-and-sharon
    const deal = parts[1] || 'rent';
    const slug = parts[2] || '';
    const params = new URLSearchParams(u.searchParams);
    params.delete('zoom');
    const region = s.region ?? REGION_SLUGS[slug];
    if (region && !params.has('region')) params.set('region', String(region));
    if (!params.has('region') && !params.has('city') && !params.has('area') && !params.has('topArea')) {
      throw new Error(`Unknown region for "${slug}" - add "region" to that search in config.json`);
    }
    const num = k => (params.has(k) ? Number(params.get(k)) : null);
    const bbox = params.get('bBox')?.split(',').map(Number);
    return {
      name: s.name || slug, url: s.url, deal, slug, params,
      f: { minPrice: num('minPrice'), maxPrice: num('maxPrice'), minRooms: num('minRooms'), maxRooms: num('maxRooms'),
           bbox: bbox?.length === 4 ? bbox : null },
    };
  });
}

function matches(it, f) {
  if (f.maxPrice != null && !(it.price <= f.maxPrice)) return false;
  if (f.minPrice != null && !(it.price >= f.minPrice)) return false;
  if (f.minRooms != null && !(it.rooms >= f.minRooms)) return false;
  if (f.maxRooms != null && !(it.rooms <= f.maxRooms)) return false;
  if (f.bbox) {
    if (it.lat == null || it.lon == null) return false;
    const [a1, o1, a2, o2] = f.bbox;
    if (it.lat < Math.min(a1, a2) || it.lat > Math.max(a1, a2)) return false;
    if (it.lon < Math.min(o1, o2) || it.lon > Math.max(o1, o2)) return false;
  }
  return true;
}

async function getPage(s, idx, page) {
  if (process.env.FEED_FIXTURE) {
    const p = path.join(process.env.FEED_FIXTURE, `${idx}-page-${page}.json`);
    return fs.existsSync(p) ? readJson(p) : { data: { pagination: { totalPages: page - 1 } } };
  }
  const q = new URLSearchParams(s.params);
  if (page > 1) q.set('page', String(page));
  const url = `https://gw.yad2.co.il/realestate-feed/${s.deal}/feed?${q.toString().replace(/%2C/gi, ',')}`;
  // Plain curl gets 200 from GitHub's runners; Node's built-in fetch gets 403 from Yad2's bot filter.
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const raw = execFileSync('curl', ['-sS', '--compressed', '-m', '30', '-b', COOKIE_JAR, '-c', COOKIE_JAR,
        '-H', 'Accept: application/json', '-w', '\n%{http_code}', url], { encoding: 'utf8', maxBuffer: 64 << 20 });
      const cut = raw.lastIndexOf('\n');
      const status = Number(raw.slice(cut + 1)), text = raw.slice(0, cut);
      if (status !== 200) throw new Error(`HTTP ${status}`);
      try { return JSON.parse(text); } catch {
        throw new Error(/captcha|shieldsquare|radware|perimeterx/i.test(text) ? 'Blocked by Yad2 bot protection (captcha)' : 'Non-JSON response');
      }
    } catch (e) { lastErr = e.stderr ? new Error(String(e.stderr).trim().split('\n').pop()) : e; await sleep(3000 * attempt); }
  }
  throw lastErr;
}

function normalize(raw, bucket, slug) {
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
    region: a.region?.text || '',
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
    promoted: !['private', 'agency'].includes(bucket),
    tags,
  };
}

async function main() {
  const prev = readJson(prevPath, {});
  const prevList = Array.isArray(prev.listings) ? prev.listings : [];
  let searches;
  const base = {
    title: cfg.title,
    newWindowHours: cfg.newWindowHours ?? 48,
    firstRunAt: prev.firstRunAt || now,
    lastAttemptAt: now,
  };
  const write = out => { fs.mkdirSync(path.dirname(outPath), { recursive: true }); fs.writeFileSync(outPath, JSON.stringify(out, null, 1)); };

  let items;
  try {
    searches = searchesFromConfig();
    const byId = new Map();
    for (const [idx, s] of searches.entries()) {
      let totalPages = 1;
      for (let page = 1; page <= Math.min(totalPages, cfg.maxPages ?? 25); page++) {
        const data = (await getPage(s, idx, page))?.data;
        if (!data || typeof data !== 'object') throw new Error(`Unexpected response shape (${s.name}, page ${page})`);
        totalPages = data.pagination?.totalPages ?? 1;
        for (const bucket of BUCKETS) {
          for (const raw of data[bucket] || []) {
            if (!raw?.token) continue;
            const it = normalize(raw, bucket, s.slug);
            if (!it.region) it.region = s.name;
            if (!matches(it, s.f)) continue; // strictly inside your filters (and map box, if any)
            if (!byId.has(it.id) || !it.promoted) byId.set(it.id, it);
          }
        }
        if (page < totalPages) await sleep(1200);
      }
    }
    items = [...byId.values()];
  } catch (e) {
    // Keep the previous listings untouched; just report the failure.
    write({ ...prev, ...base, updatedAt: prev.updatedAt || null, status: 'error', error: String(e.message || e), listings: prevList });
    console.error('Fetch failed:', e.message || e);
    return;
  }

  // When the search itself changes, listings that appear because of the new search are not "new".
  const searchKey = searches.map(s => s.params.toString()).sort().join(' | ');
  const searchChanged = prevList.length > 0 && prev.searchKey !== searchKey;
  const isBaseline = (prevList.length === 0 && !prev.updatedAt) || searchChanged;
  const prevById = new Map(prevList.map(l => [l.id, l]));
  const seen = new Set();
  const listings = items.map(it => {
    seen.add(it.id);
    const old = prevById.get(it.id);
    const history = old?.priceHistory ? [...old.priceHistory] : [{ price: it.price, at: now }];
    if (old && old.price !== it.price) history.push({ price: it.price, at: now });
    return {
      ...it,
      firstSeen: old?.firstSeen || now,
      initial: old ? !!old.initial : isBaseline, // there when tracking (or this search) started -> not "new"
      lastSeen: now,
      active: true,
      priceHistory: history.slice(-10),
    };
  });
  const keepMs = (cfg.keepRemovedDays ?? 7) * DAY;
  for (const old of prevList) {
    if (seen.has(old.id) || searchChanged) continue; // after a search change, drop listings from the old search
    const removedAt = old.active === false ? old.removedAt : now;
    if (Date.now() - new Date(removedAt).getTime() > keepMs) continue;
    listings.push({ ...old, active: false, removedAt });
  }

  write({
    ...base, updatedAt: now, status: 'ok', error: null, count: items.length, searchKey,
    searches: searches.map(s => ({ name: s.name, url: s.url })),
    listings,
  });
  const fresh = listings.filter(l => l.active && !l.initial && l.firstSeen === now).length;
  console.log(`OK: ${items.length} listings, ${fresh} new this run${searchChanged ? ' (search changed - new baseline)' : ''}`);
}

main();
