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

async function save(file, list) {
  if (!list) return;
  const prev = JSON.parse(await readFile(file, 'utf8').catch(() => '{"items":[]}'));
  if (JSON.stringify(prev.items) === JSON.stringify(list)) return console.log(file, 'unchanged');
  await writeFile(file, JSON.stringify({ updated: new Date().toISOString().slice(0, 10), items: list }) + '\n');
  console.log(file, 'updated', list.length);
}

const recentFilms = await films();
await save('data/films.json', recentFilms);

// Letterboxd blocks rating pages from servers, so the 4.5–5 star pool in data/loved.json
// was seeded once by hand; new 4.5+ ratings from the RSS feed get added here as the newest.
{
  const loved = JSON.parse(await readFile('data/loved.json', 'utf8'));
  const have = new Set(loved.pool.map(x => x.s));
  const fresh = recentFilms
    .filter(x => x.rating >= 4.5)
    .map(x => ({ t: x.title, y: x.year, r: x.rating, s: (x.url.match(/\/film\/([^/]+)\//) || [])[1], f: 0 }))
    .filter(x => x.s && !have.has(x.s));
  if (fresh.length) {
    loved.pool = [...fresh, ...loved.pool];
    await writeFile('data/loved.json', JSON.stringify(loved) + '\n');
    console.log('data/loved.json added', fresh.map(x => x.t).join(', '));
  } else console.log('data/loved.json unchanged');
}
await save('data/books.json', await books());
