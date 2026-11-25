// publisher.js  (reads main's data from the game and sends it to the board)
const BASE = 'https://v3.g.ladypopular.com';
const MAIN_LADY_ID = process.env.MAIN_LADY_ID || '8859158';
const FORM = {
  accept: '*/*', 'accept-language': 'en-US,en;q=0.9',
  'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'x-requested-with': 'XMLHttpRequest',
  referer: `${BASE}/wardrobe.php?wardrobetype=lady&archive=0&category_id%5B0%5D=9`
};
const HTML = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9', referer: `${BASE}/welcome.php`
};
const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getText(page, path) {
  const res = await page.request.get(BASE + path, { headers: HTML });
  if (!res.ok()) throw new Error(`GET ${path} returned HTTP ${res.status()}`);
  return res.text();
}
async function postJson(page, path, body) {
  const res = await page.request.post(BASE + path, { headers: FORM, data: body });
  if (!res.ok()) throw new Error(`POST ${path} returned HTTP ${res.status()}`);
  const t = await res.text();
  try { return JSON.parse(t); } catch (e) { throw new Error(`${path} gave non-JSON: ${t.slice(0, 150)}`); }
}
function grab(text, marker, open, close) {
  const s = text.indexOf(marker); if (s === -1) return null;
  const b = text.indexOf(open, s); if (b === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = b; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return JSON.parse(text.slice(b, i + 1)); }
  }
  return null;
}

async function readHeader(page, html) {
  return page.evaluate((h) => {
    const doc = new DOMParser().parseFromString(h, 'text/html');
    const txt = (el, sel) => { const e = el.querySelector(sel); return e ? e.textContent.trim() : ''; };
    const tiles = [...doc.querySelectorAll('[data-entity_type="collection"]')].map(el => {
      const left = el.querySelector('.item-timeleft');
      const a = el.querySelector('a');
      return {
        id: Number(el.getAttribute('data-id')),
        flashback: el.getAttribute('data-is_flashback') === '1',
        name: txt(el, '.item-title'),
        counter: txt(el, '.all-rewards-button-label'),
        hoursLeft: left ? Number((Number(left.getAttribute('data-time-left')) / 3600).toFixed(1)) : null,
        href: a ? a.getAttribute('href') : null
      };
    });
    const freeSlot = !!doc.querySelector('.choose-flashback-button-js[data-type="collection_types"]');
    return { tiles, freeSlot };
  }, html);
}

async function ownedInCollection(page, storeId) {
  const re = /\$\('#item-(\d+)'\)\.data\('item',\s*(\{[^\n]*?\})\);/g;
  const rows = [];
  for (let p = 1; p <= 10; p++) {
    const j = await postJson(page, '/ajax/wardrobe.php',
      `wardrobetype=lady&archive=0&pet=0&empty_filter=false&default_category=false&store_id%5B%5D=${storeId}` +
      `&page=${p}&currentPageNum=${p}&updatePartials%5B%5D=3`);
    const html = j && j.partials && j.partials.partial3;
    if (!html) break;
    for (const m of html.matchAll(re)) {
      try {
        const it = JSON.parse(m[2]);
        rows.push({ itemId: Number(it.id), category: Number(it.type), colours: (it.colors || []).map(c => Number(c.color)) });
      } catch (e) { /* skip */ }
    }
    if (!(j.options && j.options.hasMore)) break;
    await sleep(400);
  }
  return rows;
}

async function collectionListing(page, href) {
  const o = grab(await getText(page, href), 'setMallOptions(', '{', '}');
  if (!o) throw new Error('collection data (setMallOptions) not found');
  const items = Object.values(o.pagination.itemsOnPages || {}).flat();
  return { items, itemsCount: o.itemsCount, pageType: o.collectionsPage };
}

async function boardCall(payload) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(process.env.BOARD_URL, {
        method: 'POST', redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ password: process.env.BOARD_PASSWORD, ...payload })
      });
      const text = await res.text();
      let j; try { j = JSON.parse(text); } catch (e) { throw new Error(`board gave non-JSON (HTTP ${res.status}): ${text.slice(0, 120)}`); }
      if (!j.ok) throw new Error(`board said: ${j.error}`);
      return j;
    } catch (e) { lastErr = e; await sleep(3000 * attempt); }
  }
  throw lastErr;
}

module.exports = async function runPublisher(page) {
  console.log('📰 PUBLISHER');
  const out = { errors: [] };
  const fail = (where, e) => { out.errors.push(`${where}: ${e.message}`); console.log(`❌ ${where}: ${e.message}`); };

  // 1) server date, which account this is, active collections
  let tiles = [];
  try {
    const html = await getText(page, '/wardrobe.php?wardrobetype=lady&archive=0&category_id%5B0%5D=9');
    const m = html.match(/var currentTime = new Date\('([^']+)'\)/);
    if (!m) throw new Error('server clock not found');
    const d = new Date(m[1]);
    out.gameDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    out.gameTime = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const lm = html.match(/var LADY_ID = '(\d+)'/) || html.match(/lady_id=(\d+)/);
    out.ladyId = lm ? lm[1] : null;
    const nm = html.match(/id="lady-name-container">([^<]*)</);
    out.accountName = nm ? nm[1] : null;
    const h = await readHeader(page, html);
    tiles = h.tiles; out.freeFlashbackSlot = h.freeSlot;
    console.log(`🪪 Account: ${out.accountName} (Lady ID ${out.ladyId}) | 🕒 Server ${out.gameDate} ${out.gameTime} | free flashback slot: ${out.freeFlashbackSlot}`);
    console.log(`🗂️ Active collections: ${tiles.map(t => `${t.name} (${t.id}, ${t.flashback ? 'FLASHBACK' : 'LIVE'}, ${t.hoursLeft}h left, ${t.counter})`).join(' | ') || 'none'}`);
  } catch (e) { fail('server date/header', e); }

  // only main publishes: every other account stops here
  if (out.ladyId !== String(MAIN_LADY_ID)) {
    console.log(`⏭️ This is not the main account (Lady ID ${out.ladyId}). Nothing to publish.`);
    return;
  }

  // 2) what main is wearing
  let worn = [];
  try {
    const j = await postJson(page, '/ajax/wardrobe.php',
      'wardrobetype=lady&category_id%5B%5D=9&archive=0&pet=0&updatePartials%5B%5D=8');
    const arr = grab((j.partials && j.partials.partial8) || '', 'initModelImages(', '[', ']');
    if (!arr) throw new Error('worn items not found');
    worn = arr.map(x => ({
      itemId: Number(x.id), name: x.name, category: Number(x.type),
      colour: Number(x.additional && x.additional.color), layer: x.additional ? x.additional.offset : null,
      storeId: x.store_id ? Number(x.store_id) : null, eventId: x.event_id ? Number(x.event_id) : null,
      price: Number(x.price), currency: Number(x.currency), minLevel: Number(x.min_level)
    }));
  } catch (e) { fail('worn items', e); }

  // 3) owned items per active collection, checked against the header counter
  out.collections = [];
  for (const t of tiles) {
    const c = { id: t.id, name: t.name, kind: t.flashback ? 'flashback' : 'live', hoursLeft: t.hoursLeft };
    try {
      c.owned = await ownedInCollection(page, t.id);
      const have = c.owned.reduce((n, r) => n + r.colours.length, 0);
      const cm = (t.counter || '').match(/^(\d+)\s*\/\s*(\d+)/);
      c.headerOwned = cm ? Number(cm[1]) : null;
      c.checksumOk = c.headerOwned === have;
      await sleep(400);
      const L = await collectionListing(page, t.href);
      const byId = {}; L.items.forEach(i => { byId[i.id] = i; });
      c.owned.forEach(r => { const i = byId[r.itemId]; if (i) { r.price = i.price; r.currency = i.currency; } });
      console.log(`📦 ${t.name}: owned colours found ${have}, header says ${c.headerOwned} -> ${c.checksumOk ? 'OK' : 'MISMATCH'}`);
      c.owned.forEach(r => console.log(`    item ${r.itemId} (category ${r.category}) colours ${r.colours.join('/')}`));
      if (!c.checksumOk) out.errors.push(`collection ${t.id}: owned count does not match the header`);
    } catch (e) { fail(`collection ${t.id}`, e); }
    out.collections.push(c);
  }

  // 4) label the worn items
  //    event item        -> 'event'
  //    active collection -> 'live-collection' / 'flashback-collection'
  //    anything else     -> 'mall' (every item comes from the mall, a collection or an event;
  //                         followers look for it in their own mall listing and skip it if it is not there)
  out.worn = [];
  for (const w of worn) {
    let kind;
    if (w.eventId) kind = 'event';
    else {
      const t = tiles.find(x => x.id === w.storeId);
      if (t) kind = t.flashback ? 'flashback-collection' : 'live-collection';
      else kind = 'mall';
    }
    w.kind = kind; out.worn.push(w);
    console.log(`👗 layer ${w.layer}: item ${w.itemId} ${w.name} colour ${w.colour} | store ${w.storeId} event ${w.eventId} | ${kind}`);
  }
  // Any look that was read is offered to the followers. Each follower copies it only if it owns every piece
  // (event items included), so a look nobody can complete is simply ignored.
  out.dressUp = out.worn.length > 0;
  out.reason = out.worn.length === 0 ? 'no worn items read' : 'look read; followers copy it only if they own every piece';
  const eventCount = out.worn.filter(w => w.eventId).length;
  console.log(`🎯 Dress up offered: ${out.dressUp ? 'YES' : 'NO'} (${out.reason}) | ${out.worn.length} pieces, ${eventCount} of them event items`);

  // 5) build the record and send it (only if everything read cleanly)
  const record = {
    version: 1, gameDate: out.gameDate, gameTime: out.gameTime,
    dressUp: out.dressUp, reason: out.reason,
    look: out.worn.map(w => ({ itemId: w.itemId, category: w.category, colour: w.colour, layer: w.layer,
      kind: w.kind, storeId: w.storeId, price: w.price, currency: w.currency, minLevel: w.minLevel })),
    collections: out.collections.map(c => ({ id: c.id, name: c.name, kind: c.kind, hoursLeft: c.hoursLeft, owned: c.owned }))
  };
  const clean = out.errors.length === 0 && out.worn.length > 0 && out.collections.every(c => c.checksumOk);
  if (!clean) {
    console.log('⚠️ Something did not read cleanly, so nothing is sent. The board keeps its old record.');
    out.errors.forEach(e => console.log('   - ' + e));
    return;
  }
  if (process.env.BOARD_PUBLISH !== '1' || !process.env.BOARD_URL || !process.env.BOARD_PASSWORD) {
    console.log('ℹ️ Everything read cleanly, but sending is switched off (needs BOARD_PUBLISH=1, BOARD_URL and BOARD_PASSWORD). Nothing sent.');
    return;
  }
  try {
    const saved = await boardCall({ action: 'save', record });
    console.log(`📤 Sent to the board (${saved.parts} part(s)), saved at ${saved.savedAt}`);
    const back = await boardCall({ action: 'read' });
    const r = back.record;
    if (r && r.gameDate === record.gameDate && r.savedAt === saved.savedAt && r.look.length === record.look.length) {
      console.log(`✅ Read back from the board: ${r.gameDate}, ${r.look.length} worn items, ${r.collections.length} collection(s). It arrived correctly.`);
    } else {
      throw new Error('the board returned something different from what was sent');
    }
  } catch (e) {
    console.log(`❌ Could not publish: ${e.message}`);
    throw e;
  }
};
