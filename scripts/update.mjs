// Pulls recent films (Letterboxd RSS) and books (Goodreads RSS) into data/*.json.
// Runs in GitHub Actions on a schedule. No dependencies.
import { readFile, writeFile } from 'node:fs/promises';

const LETTERBOXD = 'https://letterboxd.com/itsameaustin/rss/';
const LASTFM_USER = 'austinwang97';

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

// Goodreads killed its feeds and hides shelf pages from signed-out visitors, but the
// "custom widget" meant for embedding a shelf on personal sites is still public.
const GR_WIDGET = 'https://www.goodreads.com/review/custom_widget/26112762.Recently%20read?cover_position=none&cover_size=small&num_books=10&order=d&shelf=read&show_author=1&show_cover=0&show_rating=1&show_review=0&show_tags=0&show_title=1&sort=date_read&widget_bg_color=FFFFFF&widget_bg_transparent=true&widget_border_width=none&widget_id=austinwangnet&widget_text_color=000000&widget_title_size=medium&widget_width=medium';
const RATING_WORDS = { 'did not like it': 1, 'it was ok': 2, 'liked it': 3, 'really liked it': 4, 'it was amazing': 5 };
const strip = h => decode(h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

async function books() {
  const js = await get(GR_WIDGET);
  const start = js.indexOf("var widget_code = '");
  if (start < 0) { console.log('goodreads widget: no widget_code (private shelf or format change)'); return null; }
  const end = js.indexOf("var widget_div", start);
  const raw = js.slice(start + 19, end).replace(/';?\s*$/, '');
  const html = raw.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c) => c[0] === 'u' && c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16)) : ({ n: '\n', t: '\t', r: '' }[c] ?? c));
  const blocks = html.split(/class="gr_custom_each_container[^"]*"/).slice(1);
  const out = blocks.map(b => {
    const t = b.match(/class="gr_custom_title[^"]*"[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const a = b.match(/class="gr_custom_author[^"]*"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
    const r = b.match(/class="gr_custom_rating[^"]*"([\s\S]*?)<\/div>/);
    let rating = null;
    if (r) {
      const stars = [...r[1].matchAll(/gr_flat_red_star_(active|inactive|(\d+)pct)/g)];
      if (stars.length) rating = stars.reduce((sum, m) => sum + (m[1] === "active" ? 1 : m[2] ? Number(m[2]) / 100 : 0), 0) || null;
      else { const word = Object.keys(RATING_WORDS).find(w => r[1].includes(`title="${w}"`)); rating = word ? RATING_WORDS[word] : null; }
    }
    const d = b.match(/(?:read|date read)[^<]*?((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4})/i);
    const title = t ? strip(t[2]).replace(/:.*$/, '').replace(/\s*\(.*\)$/, '') : '';
    let url = t ? t[1] : '';
    if (url.startsWith('/')) url = 'https://www.goodreads.com' + url;
    return { title, author: a ? strip(a[1]) : '', rating, read: d ? new Date(d[1]).toISOString().slice(0, 10) : null, url: url.split('?')[0], source: 'widget' };
  }).filter(x => x.title);
  const prev = JSON.parse(await readFile('data/books.json', 'utf8').catch(() => '{"items":[]}')).items;
  // The widget has no dates; keep known ones, and date a newly seen book by the day it showed up
  // (the job runs every 6 hours, so that's within hours of logging it).
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  for (const x of out) {
    const known = prev.find(p => p.title === x.title);
    x.read = x.read || known?.read || (known ? null : today);
  }
  console.log('goodreads widget:', out.length, 'books; first:', out[0]?.title, out[0]?.rating);
  return out.length ? out : null;
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
