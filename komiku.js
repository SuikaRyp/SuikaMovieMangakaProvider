// Komiku provider — https://komiku.org
// Komik (manga / manhwa / manhua) bahasa Indonesia. Halaman SSR: listing,
// detail, dan gambar chapter semuanya ada di HTML (regex, tanpa DOM).
//
// Ported dari scraper komiku.js (xvlovers):
//   https://github.com/xvlovers/kumpulan-scrape-dan-plugin-esm-cjs-/blob/main/komiku.js
//
// Id komik = slug (mis. "one-piece"); id chapter = slug chapter.
// search('') mengembalikan daftar terbaru, supaya health-check punya hasil.

var SOURCE_ID = 'komiku';
var SITE = 'https://komiku.org';
var API = 'https://api.komiku.org';
var REFERER = SITE + '/';
var UA = 'Mozilla/5.0 (Linux; Android 13; SM-A536E) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/124.0.0.0 Mobile Safari/537.36';

function getInfo() {
  return {
    name: 'Komiku',
    lang: 'id',
    baseUrl: SITE,
    logo: SITE + '/favicon.ico',
    type: 'manga',
    version: '1.0.0'
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function _get(url) {
  return fetch(url, { headers: {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
    'Referer': REFERER
  } }).then(function (r) { return (r && r.body) || ''; }).catch(function () { return ''; });
}

function _allMatches(html, regex) {
  var out = [];
  var m; regex.lastIndex = 0;
  while ((m = regex.exec(html)) !== null) {
    out.push(m);
    if (m.index === regex.lastIndex) regex.lastIndex++;
  }
  return out;
}

function _decode(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); });
}

function _text(html) {
  return _decode(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

function _attr(tag, name) {
  var m = String(tag || '').match(new RegExp('\\s' + name + '\\s*=\\s*"([^"]*)"', 'i'))
    || String(tag || '').match(new RegExp("\\s" + name + "\\s*=\\s*'([^']*)'", 'i'));
  return m ? _decode(m[1]) : null;
}

function _abs(href) {
  if (!href) return null;
  href = String(href).trim();
  if (/^https?:\/\//i.test(href)) return href;
  if (href.indexOf('//') === 0) return 'https:' + href;
  return SITE + (href.charAt(0) === '/' ? href : '/' + href);
}

// asset/img/lazy.jpg adalah placeholder lazy-load, bukan gambar sungguhan.
function _isLazy(u) { return !u || /\/lazy\.(jpe?g|png|gif|webp)/i.test(u) || /^data:/i.test(u); }

function _img(tag) {
  var c = [_attr(tag, 'data-src'), _attr(tag, 'data-lazy-src'), _attr(tag, 'src')];
  for (var i = 0; i < c.length; i++) { if (c[i] && !_isLazy(c[i])) return _abs(c[i]); }
  return null;
}

// "https://komiku.org/manga/one-piece/" | "/manga/one-piece/" | "one-piece" -> "one-piece"
function _slug(u) {
  var s = String(u || '');
  var m = s.match(/\/manga\/([^\/?#]+)/i);
  if (m) return m[1];
  if (/^https?:\/\//i.test(s)) return null;
  s = s.replace(/^\/+|\/+$/g, '');
  return s && s.indexOf('/') < 0 ? s : null;
}

// "https://komiku.org/one-piece-chapter-1100/" -> "one-piece-chapter-1100"
function _chSlug(u) {
  var m = String(u || '').match(/^(?:https?:\/\/[^\/]+)?\/?([^\/?#]*-chapter-[^\/?#]*)/i);
  return m ? m[1] : null;
}

function _cleanTitle(t) {
  return String(t || '').replace(/^\s*(?:Baca\s+)?(?:Komik|Manga|Manhwa|Manhua)\s+/i, '')
    .replace(/\s+Bahasa\s+Indonesia\s*$/i, '').replace(/\s+/g, ' ').trim();
}

function _altTitle(tag) {
  var alt = _attr(tag, 'alt') || _attr(tag, 'title') || '';
  return _cleanTitle(alt.replace(/^\s*Baca\s+(?:Komik\s+)?(?:Manga|Manhwa|Manhua)?\s*/i, ''));
}

function _statusOf(s) {
  s = String(s || '').toLowerCase();
  if (s.indexOf('berjalan') !== -1 || s.indexOf('ongoing') !== -1) return 'ongoing';
  if (s.indexOf('tamat') !== -1 || s.indexOf('selesai') !== -1 || s.indexOf('completed') !== -1) return 'completed';
  if (s.indexOf('hiatus') !== -1) return 'hiatus';
  if (s.indexOf('dibatalkan') !== -1 || s.indexOf('cancel') !== -1) return 'cancelled';
  return 'unknown';
}

// Semua tautan /manga/<slug>/ pada sebuah halaman -> kartu unik.
function _cardsFrom(html) {
  var out = [], idx = {};
  var re = /<a\b([^>]*?)href="([^"]*\/manga\/[^"\/?#]+\/?[^"]*)"([^>]*)>([\s\S]*?)<\/a>/gi;
  var ms = _allMatches(String(html || ''), re);
  for (var k = 0; k < ms.length; k++) {
    var m = ms[k];
    var slug = _slug(m[2]);
    if (!slug || slug === 'page') continue;
    var inner = m[4];
    var imTag = (inner.match(/<img\b[^>]*>/i) || [''])[0];
    var cover = imTag ? _img(imTag) : null;
    var hm = inner.match(/<h[2-5][^>]*>([\s\S]*?)<\/h[2-5]>/i);
    var title = hm ? _cleanTitle(_text(hm[1])) : '';
    if (!title) title = _cleanTitle(_attr(m[1] + ' ' + m[3], 'title') || '');
    if (!title && imTag) title = _altTitle(imTag);
    if (!title && !imTag) title = _cleanTitle(_text(inner));
    var at = idx[slug];
    if (!at) {
      at = { id: slug, title: '', cover: null, coverHeaders: { 'Referer': REFERER },
        url: SITE + '/manga/' + slug + '/', type: 'manga' };
      idx[slug] = at; out.push(at);
    }
    if (title && (!at.title || title.length > at.title.length)) at.title = title;
    if (cover && !at.cover) at.cover = cover;
  }
  var res = [];
  for (var i = 0; i < out.length; i++) {
    if (out[i].title && out[i].title.length > 1) res.push(out[i]);
  }
  return res;
}

function _firstList(urls, limit) {
  var i = 0;
  function next() {
    if (i >= urls.length) return Promise.resolve([]);
    return _get(urls[i++]).then(function (html) {
      var items = _cardsFrom(html).slice(0, limit);
      return items.length ? items : next();
    });
  }
  return next();
}

// ── Search / browse ──────────────────────────────────────────────────────────
// `category` boleh string ('latest' | 'popular' | 'trending') atau { category }.
function search(query, page, category) {
  page = parseInt(page, 10) > 1 ? parseInt(page, 10) : 1;
  if (category && typeof category === 'object') category = category.category;
  category = String(category || '').toLowerCase();
  var q = String(query || '').trim();
  var urls;
  if (q) {
    var enc = encodeURIComponent(q);
    var pre = page > 1 ? '/page/' + page + '/' : '/';
    urls = [SITE + pre + '?post_type=manga&s=' + enc, API + pre + '?post_type=manga&s=' + enc];
  } else if (category === 'popular' || category === 'ranking') {
    urls = [SITE + '/p/ranking/'];
  } else if (category === 'trending') {
    urls = [SITE + '/p/trending/'];
  } else {
    urls = [SITE + '/'];
  }
  return _firstList(urls, 40).catch(function () { return []; });
}

// ── Detail ───────────────────────────────────────────────────────────────────
function _parseChapters(html) {
  var chs = [], seen = {};
  var re = /<a\b([^>]*?)href="([^"]*-chapter-[^"]*)"([^>]*)>([\s\S]*?)<\/a>/gi;
  var ms = _allMatches(String(html || ''), re);
  for (var i = 0; i < ms.length; i++) {
    var m = ms[i];
    var abs = _abs(m[2]);
    var cslug = _chSlug(abs);
    if (!abs || !cslug || seen[cslug]) continue;
    seen[cslug] = 1;
    var title = _text(m[4]) || _attr(m[1] + ' ' + m[3], 'title') || '';
    var nm = (title.match(/chapter\s*(\d+(?:[.,]\d+)?)/i)
      || cslug.match(/-chapter-(\d+(?:[-.]\d+)?)/i) || [])[1];
    var num = nm ? parseFloat(String(nm).replace(',', '.').replace('-', '.')) : NaN;
    var after = String(html).substr(m.index + m[0].length, 400);
    var dm = after.match(/tanggalseries[^>]*>([^<]+)</i);
    chs.push({ id: cslug, title: title, number: isNaN(num) ? null : num,
      url: abs, date: dm ? _text(dm[1]) : '', _o: chs.length });
  }
  // Manga: terbaru di atas. Urutkan turun per nomor; tanpa nomor, pertahankan urutan halaman.
  chs.sort(function (a, b) {
    if (a.number !== null && b.number !== null && a.number !== b.number) return b.number - a.number;
    return a._o - b._o;
  });
  for (var j = 0; j < chs.length; j++) {
    if (!chs[j].title) chs[j].title = chs[j].number !== null ? ('Chapter ' + chs[j].number) : chs[j].id;
    delete chs[j]._o;
  }
  return chs;
}

function getDetail(url) {
  var id = String(url || '');
  var slug = _slug(id);
  var path = /^https?:\/\//i.test(id) ? id
    : (slug ? SITE + '/manga/' + slug + '/' : _abs(id));
  return _get(path).then(function (html) {
    if (!html) throw new Error('detail HTTP error: ' + path);
    var h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    var title = h1 ? _cleanTitle(_text(h1[1])) : '';

    var og = html.match(/<meta[^>]+property="og:image"[^>]*>/i);
    var cover = og ? _attr(og[0], 'content') : null;
    if (!cover || _isLazy(cover)) {
      var im = html.match(/class="[^"]*\b(?:ims|thumb)\b[^"]*"[\s\S]*?(<img[^>]*>)/i);
      cover = im ? _img(im[1]) : null;
    }

    var syn = html.match(/<(?:p|div|section)[^>]*class="[^"]*\b(?:desc|entry-content-single|sinopsis)\b[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div|section)>/i)
      || html.match(/<(?:p|div|section)[^>]*id="Sinopsis"[^>]*>([\s\S]*?)<\/(?:p|div|section)>/i);
    var description = syn ? _text(syn[1]) : '';
    if (!description) {
      var dm = html.match(/<meta[^>]+name="description"[^>]*>/i);
      description = dm ? (_attr(dm[0], 'content') || '') : '';
    }

    // Tabel info: <tr><td>Label</td><td>Nilai</td></tr>, juga bentuk "Label: Nilai".
    var info = {}, m;
    var rows = _allMatches(html, /<tr[^>]*>([\s\S]*?)<\/tr>/gi);
    for (var r = 0; r < rows.length; r++) {
      var tds = rows[r][1].match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [];
      if (tds.length < 2) continue;
      var label = _text(tds[0]).replace(/:$/, '').toLowerCase().replace(/\s+/g, '_');
      var val = _text(tds[1]);
      if (label && val && val !== '-') info[label] = val;
    }
    var spans = _allMatches(html, /<span[^>]*>([^<:]{2,30}):\s*([^<]{1,200})<\/span>/gi);
    for (var s = 0; s < spans.length; s++) {
      var k2 = _text(spans[s][1]).toLowerCase().replace(/\s+/g, '_');
      var v2 = _text(spans[s][2]);
      if (k2 && v2 && !info[k2]) info[k2] = v2;
    }

    var genres = [];
    var gms = _allMatches(html, /<a[^>]+href="[^"]*\/(?:genre|genres)\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi);
    for (var g = 0; g < gms.length; g++) {
      var gn = _text(gms[g][1]);
      if (gn && genres.indexOf(gn) === -1) genres.push(gn);
    }

    var author = info.pengarang || info.author || info.komikus || info.penulis || '';
    var chapters = _parseChapters(html);

    return {
      id: slug || id,
      title: title || slug || id,
      cover: cover ? _abs(cover) : null,
      coverHeaders: { 'Referer': REFERER },
      url: slug ? SITE + '/manga/' + slug + '/' : path,
      author: author,
      authors: author ? [author] : [],
      description: description,
      status: _statusOf(info.status || info.status_komik),
      genres: genres.slice(0, 12),
      chapters: chapters,
      type: 'manga'
    };
  });
}

function getChapters(url) {
  var id = String(url || '');
  var slug = _slug(id);
  var path = /^https?:\/\//i.test(id) ? id
    : (slug ? SITE + '/manga/' + slug + '/' : _abs(id));
  return _get(path).then(function (html) { return _parseChapters(html); });
}

// ── Pages ────────────────────────────────────────────────────────────────────
function _pageOk(u) {
  if (!u || _isLazy(u)) return false;
  if (/(^|[\/_\-.])(logo|favicon|avatar|banner|ads?|placeholder|loading|icon)([\/_\-.]|$)/i.test(u)) return false;
  return true;
}

function _uniq(arr) {
  var out = [], seen = {};
  for (var i = 0; i < arr.length; i++) { if (arr[i] && !seen[arr[i]]) { seen[arr[i]] = 1; out.push(arr[i]); } }
  return out;
}

function _pageImages(html) {
  var h = String(html || '');
  var zone = h.match(/id="(?:Baca_Komik|baca-comic|readerarea|chimg)"[\s\S]*?(?=<footer|id="Komentar"|class="[^"]*\bnavig|$)/i);
  var scope = zone ? zone[0] : '';
  var out = [], i, ms, u;
  ms = _allMatches(scope, /<img\b[^>]*>/gi);
  for (i = 0; i < ms.length; i++) { u = _img(ms[i][0]); if (_pageOk(u)) out.push(u); }
  if (out.length < 2) {
    out = [];
    ms = _allMatches(h, /<img\b[^>]*>/gi);
    for (i = 0; i < ms.length; i++) { u = _img(ms[i][0]); if (_pageOk(u)) out.push(u); }
  }
  return _uniq(out);
}

function getPages(chapterUrl) {
  var u = String(chapterUrl || '');
  if (!u) return Promise.reject(new Error('url chapter kosong'));
  var url = /^https?:\/\//i.test(u) ? u : _abs(u.replace(/^\/?/, '/').replace(/\/?$/, '/'));
  return _get(url).then(function (html) {
    var imgs = _pageImages(html);
    if (!imgs.length) throw new Error('No pages found');
    var out = [];
    for (var i = 0; i < imgs.length; i++) {
      out.push({ url: imgs[i], index: i, headers: { 'Referer': REFERER, 'User-Agent': UA } });
    }
    return out;
  });
}

function getChapterContent(chapterUrl) {
  return { text: 'Komiku is a manga-only source.', nextUrl: null };
}
