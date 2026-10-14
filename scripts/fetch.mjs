// Pulls the Yad2 search in config.json and merges it with the previous snapshot.
// Usage: node scripts/fetch.mjs <prev.json> <out.json>
// Test mode: FEED_FIXTURE=dir  -> reads page-1.json, page-2.json ... instead of calling Yad2.
import fs from 'node:fs';
import path from 'node:path';

const [prevPath, outPath] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'config.json'), 'utf8'));
const now = new Date().toISOString();
const DAY = 864e5;

// Yad2 map-URL slug -> region id (the API needs the id). Add more if you search elsewhere.
const REGION_SLUGS = { 'coastal-north': 5 };

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function buildQuery() {
  const u = new URL(cfg.searchUrl);
  const parts = u.pathname.split('/').filter(Boolean); // realestate / rent / coastal-north
  const deal = parts[1] || 'rent';
  const slug = parts[2] || '';
  const params = new URLSearchParams(u.searchParams);
  params.delete('zoom');
  const region = cfg.region ?? REGION_SLUGS[slug];
  if (region && !params.has('region')) params.set('region', String(region));
  if (!params.has('region') && !params.has('city') && !params.has('area') && !params.has('topArea')) {
    throw new Error(`Unknown region for "${slug}" - set "region" in config.json`);
  }
  return { deal, slug, params };
}

function filters(params) {
  const num = k => (params.has(k) ? Number(params.get(k)) : null);
  const bbox = params.get('bBox')?.split(',').map(Number);
  return {
    minPrice: num('minPrice'), maxPrice: num('maxPrice'),
    minRooms: num('minRooms'), maxRooms: num('maxRooms'),
    bbox: bbox?.length === 4 ? bbox : null, // lat1, lon1, lat2, lon2
  };
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getPage(deal, params, page) {
  if (process.env.FEED_FIXTURE) {
    const p = path.join(process.env.FEED_FIXTURE, `page-${page}.json`);
    if (!fs.existsSync(p)) return { data: { private: [], agency: [], pagination: { totalPages: page - 1 } } };
    return readJson(p);
  }
  const q = new URLSearchParams(params);
  if (page > 1) q.set('page', String(page));
  const url = `https://gw.yad2.co.il/realestate-feed/${deal}/feed?${q}`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
          'Origin': 'https://www.yad2.co.il',
          'Referer': 'https://www.yad2.co.il/',
        },
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      try { return JSON.parse(text); } catch {
        throw new Error(/captcha|shieldsquare|radware|perimeterx/i.test(text) ? 'Blocked by Yad2 bot protection (captcha)' : 'Non-JSON response');
      }
    } catch (e) { lastErr = e; await sleep(3000 * attempt); }
  }
  throw lastErr;
}

function normalize(raw, slug) {
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
    city: a.city?.text || '',
    neighborhood: a.neighborhood?.text || '',
    street: [a.street?.text, a.house?.number].filter(Boolean).join(' '),
    lat: a.coords?.lat ?? null,
    lon: a.coords?.lon ?? null,
    image: m.coverImage || null,
    images: Array.isArray(m.images) ? m.images.length : 0,
    seller: raw.adType === 'private' ? 'private' : 'agency',
    agency: raw.customer?.agencyName || '',
    promoted: !['private', 'agency'].includes(raw._bucket),
    tags,
  };
}

async function main() {
  const prev = readJson(prevPath, {});
  const prevList = Array.isArray(prev.listings) ? prev.listings : [];
  const base = {
    title: cfg.title,
    searchUrl: cfg.searchUrl,
    newWindowHours: cfg.newWindowHours ?? 48,
    firstRunAt: prev.firstRunAt || now,
    lastAttemptAt: now,
  };

  let items;
  try {
    const { deal, slug, params } = buildQuery();
    const f = filters(params);
    const byId = new Map();
    let totalPages = 1;
    for (let page = 1; page <= Math.min(totalPages, cfg.maxPages ?? 20); page++) {
      const json = await getPage(deal, params, page);
      const data = json?.data;
      if (!data || typeof data !== 'object') throw new Error('Unexpected response shape');
      totalPages = data.pagination?.totalPages ?? 1;
      for (const bucket of ['private', 'agency', 'platinum', 'leadingBroker', 'kingOfTheHar', 'trio', 'booster']) {
        for (const raw of data[bucket] || []) {
          if (!raw?.token) continue;
          const it = normalize({ ...raw, _bucket: bucket }, slug);
          if (!matches(it, f)) continue; // strictly inside your filters + map area
          if (!byId.has(it.id) || !it.promoted) byId.set(it.id, it);
        }
      }
      if (page < totalPages) await sleep(1500);
    }
    items = [...byId.values()];
  } catch (e) {
    // Keep the previous listings untouched; just report the failure.
    const out = { ...prev, ...base, updatedAt: prev.updatedAt || null, status: 'error', error: String(e.message || e), listings: prevList };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
    console.error('Fetch failed:', e.message || e);
    return;
  }

  const isFirstRun = prevList.length === 0 && !prev.updatedAt;
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
      initial: old ? !!old.initial : isFirstRun, // present on the very first run -> not "new"
      lastSeen: now,
      active: true,
      priceHistory: history.slice(-10),
    };
  });
  const keepMs = (cfg.keepRemovedDays ?? 7) * DAY;
  for (const old of prevList) {
    if (seen.has(old.id)) continue;
    const removedAt = old.active === false ? old.removedAt : now;
    if (Date.now() - new Date(removedAt).getTime() > keepMs) continue;
    listings.push({ ...old, active: false, removedAt });
  }

  const out = { ...base, updatedAt: now, status: 'ok', error: null, count: items.length, listings };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  const fresh = listings.filter(l => l.active && !l.initial && l.firstSeen === now).length;
  console.log(`OK: ${items.length} listings, ${fresh} new this run`);
}

main();
