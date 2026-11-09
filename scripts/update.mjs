// Pulls recent films (Letterboxd RSS) and books (Goodreads RSS) into data/*.json.
// Runs in GitHub Actions on a schedule. No dependencies.
import { readFile, writeFile } from 'node:fs/promises';

const LETTERBOXD = 'https://letterboxd.com/itsameaustin/rss/';
const LASTFM_USER = 'austinwang97';
const GOODREADS = process.env.GOODREADS_RSS || ''; // e.g. https://www.goodreads.com/review/list_rss/26112762?key=...&shelf=read

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').trim() : '';
};
const items = xml => [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
const decode = s => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const get = async url => { const r = await fetch(url, { headers: { 'user-agent': 'austinwang.net feed updater' } }); if (!r.ok) throw new Error(`${url} -> ${r.status}`); return r.text(); };

async function films() {
  const xml = await get(LETTERBOXD);
  return items(xml)
    .filter(i => tag(i, 'letterboxd:filmTitle'))
    .slice(0, 10)
    .map(i => ({
      title: decode(tag(i, 'letterboxd:filmTitle')),
      year: tag(i, 'letterboxd:filmYear'),
      rating: tag(i, 'letterboxd:memberRating') ? Number(tag(i, 'letterboxd:memberRating')) : null,
      watched: tag(i, 'letterboxd:watchedDate'),
      url: tag(i, 'link'),
    }));
}

async function books() {
  if (!GOODREADS) return null;
  const xml = await get(GOODREADS);
  return items(xml)
    .slice(0, 10)
    .map(i => ({
      title: decode(tag(i, 'title')),
      author: decode(tag(i, 'author_name')),
      rating: Number(tag(i, 'user_rating')) || null,
      read: tag(i, 'user_read_at'),
      url: tag(i, 'link'),
    }));
}

// Every film rated 4.5 or 5, newest first, plus the four profile favourites.
async function loved() {
  const pool = [];
  for (const r of ['5', '4.5']) {
    const list = [];
    for (let p = 1; p <= 15; p++) {
      const html = await get(`https://letterboxd.com/itsameaustin/films/rated/${r}/by/date/page/${p}/`);
      const got = [...html.matchAll(/data-item-name="([^"]+)"[\s\S]*?data-item-slug="([^"]+)"/g)];
      if (!got.length) break;
      got.forEach(m => list.push([decode(m[1]).replace(/&#039;/g, "'"), m[2]]));
    }
    list.forEach(([name, slug], i) => {
      const m = name.match(/^(.*) \((\d{4})\)$/);
      pool.push({ t: m ? m[1] : name, y: m ? m[2] : '', r: Number(r), s: slug, f: +(i / list.length).toFixed(3) });
    });
  }
  const profile = await get('https://letterboxd.com/itsameaustin/');
  const favBlock = profile.split('id="favourites"')[1]?.split('</section>')[0] || '';
  const fav = [...favBlock.matchAll(/data-item-slug="([^"]+)"/g)].map(m => m[1]);
  return pool.length ? { fav: [...new Set(fav)], pool } : null;
}

async function save(file, list) {
  if (!list) return;
  const prev = JSON.parse(await readFile(file, 'utf8').catch(() => '{"items":[]}'));
  if (JSON.stringify(prev.items) === JSON.stringify(list)) return console.log(file, 'unchanged');
  await writeFile(file, JSON.stringify({ updated: new Date().toISOString().slice(0, 10), items: list }) + '\n');
  console.log(file, 'updated', list.length);
}

await save('data/films.json', await films());
await save('data/books.json', await books());
try {
  const l = await loved();
  if (l) {
    const prev = await readFile('data/loved.json', 'utf8').catch(() => '');
    const next = JSON.stringify(l) + '\n';
    if (prev !== next) { await writeFile('data/loved.json', next); console.log('data/loved.json updated', l.pool.length, 'films,', l.fav.length, 'favourites'); }
    else console.log('data/loved.json unchanged');
  }
} catch (e) { console.log('loved skipped:', e.message); }
