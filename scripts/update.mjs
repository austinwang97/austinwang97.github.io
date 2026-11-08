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

// Last.fm public profile pages (no API key needed). Spotify plays are logged there.
const rows = html => [...html.matchAll(/<tr[^>]*class="[^"]*chartlist-row[^"]*"[\s\S]*?<\/tr>/g)].map(m => m[0]);
const titleIn = (row, cls) => { const m = row.match(new RegExp(`class="[^"]*${cls}[^"]*"[\\s\\S]*?<a[^>]*title="([^"]+)"`)); return m ? decode(m[1]) : ''; };
async function music() {
  const recent = rows(await get(`https://www.last.fm/user/${LASTFM_USER}`)).slice(0, 8)
    .map(r => ({ track: titleIn(r, 'chartlist-name'), artist: titleIn(r, 'chartlist-artist'), now: /chartlist-now-scrobbling|is-now-playing/.test(r) }))
    .filter(r => r.track && r.artist);
  const top = rows(await get(`https://www.last.fm/user/${LASTFM_USER}/library/artists?date_preset=LAST_30_DAYS`)).slice(0, 8)
    .map(r => ({ artist: titleIn(r, 'chartlist-name'), plays: Number((r.match(/([\d,]+)\s*<span[^>]*>\s*scrobbles/) || r.match(/([\d,]+)\s+scrobbles/) || [])[1]?.replace(/,/g, '')) || null }))
    .filter(r => r.artist);
  return { recent, top };
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
  const m = await music();
  const prev = JSON.parse(await readFile('data/music.json', 'utf8').catch(() => '{}'));
  if (JSON.stringify({ recent: prev.recent, top: prev.top }) !== JSON.stringify(m)) {
    await writeFile('data/music.json', JSON.stringify({ updated: new Date().toISOString().slice(0, 10), ...m }) + '\n');
    console.log('data/music.json updated', m.recent.length, m.top.length);
  } else console.log('data/music.json unchanged');
} catch (e) { console.log('music skipped:', e.message); }
