// Hash router + page renderers.
//
// Routes:  #/  #/posts  #/posts/<slug>[?h=<heading>]  #/tags  #/tags/<tag>
//          #/search[?q=<query>]  #/about  (anything else → 404)

import { renderMarkdown, copyCode } from './markdown.js';
import { searchPosts } from './search.js';

const SITE = 'tranchucthien@kb';
const HOME_POSTS = 10;
const HOME_TAGS = 15;

const app = document.getElementById('app');
let indexPromise = null;
let navToken = 0; // incremented on every navigation; stale async renders bail out

// ---------- helpers ----------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const enc = encodeURIComponent;

function loadIndex() {
  indexPromise ??= fetch('posts.json', { cache: 'no-cache' })
    .then((r) => {
      if (!r.ok) throw new Error(`posts.json: HTTP ${r.status}. Run "node scripts/build-index.mjs" to generate it.`);
      return r.json();
    })
    .catch((err) => {
      indexPromise = null; // allow retry
      throw err;
    });
  return indexPromise;
}

async function fetchText(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const q = raw.indexOf('?');
  const path = q >= 0 ? raw.slice(0, q) : raw;
  const parts = path.split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  return { parts, params: new URLSearchParams(q >= 0 ? raw.slice(q + 1) : '') };
}

function setTitle(title) {
  document.title = title ? `${title} · ${SITE}` : SITE;
}

function setActiveNav(section) {
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === section) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

function tagCounts(posts) {
  const counts = new Map();
  for (const p of posts) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const tagLink = (t, count) =>
  `<a class="tag" href="#/tags/${enc(t)}">#${esc(t)}${count ? `<span class="count">(${count})</span>` : ''}</a>`;

const postItem = (p, { summary = false } = {}) => `
  <li class="post-item">
    <time datetime="${esc(p.date)}">${esc(p.date)}</time>
    <div>
      <a class="post-title" href="#/posts/${enc(p.slug)}">${esc(p.title)}</a>
      ${summary && p.summary ? `<p class="summary">${esc(p.summary)}</p>` : ''}
      ${p.tags.length ? `<div class="tags">${p.tags.map((t) => tagLink(t)).join('')}</div>` : ''}
    </div>
  </li>`;

const postList = (posts, opts) =>
  posts.length ? `<ul class="post-list">${posts.map((p) => postItem(p, opts)).join('')}</ul>` : '<p class="muted">(empty)</p>';

// ---------- pages ----------

function renderHome(posts) {
  setTitle('');
  const tags = tagCounts(posts).slice(0, HOME_TAGS);
  app.innerHTML = `
    <p class="cmd">whoami</p>
    <p class="intro"><strong>Tran Chuc Thien</strong> — DevOps / software engineer.</p>
    <p class="intro muted">Notes on infrastructure, cloud, CI/CD and the bugs I hit along the way.</p>

    <p class="cmd">ls -t posts/ | head -${HOME_POSTS}</p>
    ${postList(posts.slice(0, HOME_POSTS), { summary: true })}
    ${posts.length > HOME_POSTS ? `<p class="more"><a href="#/posts">→ all ${posts.length} posts</a></p>` : ''}

    ${tags.length ? `
      <p class="cmd">cut -d, -f tags posts/* | sort | uniq -c | sort -rn</p>
      <ul class="tag-cloud">${tags.map(([t, n]) => `<li>${tagLink(t, n)}</li>`).join('')}</ul>
      <p class="more"><a href="#/tags">→ all tags</a></p>` : ''}
  `;
}

function renderPosts(posts) {
  setTitle('posts');
  const byYear = Map.groupBy
    ? Map.groupBy(posts, (p) => p.date.slice(0, 4))
    : posts.reduce((m, p) => m.set(p.date.slice(0, 4), [...(m.get(p.date.slice(0, 4)) ?? []), p]), new Map());
  app.innerHTML = `
    <p class="cmd">ls -l posts/ | wc -l</p>
    <h1 class="page-title">posts <span class="muted">(${posts.length})</span></h1>
    ${[...byYear].map(([year, list]) => `<h2 class="year">${esc(year)}</h2>${postList(list)}`).join('') || '<p class="muted">(empty)</p>'}
  `;
}

function renderTags(posts) {
  setTitle('tags');
  const tags = tagCounts(posts);
  app.innerHTML = `
    <p class="cmd">ls tags/</p>
    <h1 class="page-title">tags <span class="muted">(${tags.length})</span></h1>
    <ul class="tag-cloud">${tags.map(([t, n]) => `<li>${tagLink(t, n)}</li>`).join('')}</ul>
  `;
}

function renderTag(posts, tag) {
  const list = posts.filter((p) => p.tags.includes(tag));
  if (!list.length) return renderNotFound(`tags/${tag}`);
  setTitle(`#${tag}`);
  app.innerHTML = `
    <p class="cmd">grep -l "#${esc(tag)}" posts/*</p>
    <h1 class="page-title"><span class="hash">#</span>${esc(tag)} <span class="muted">(${list.length})</span></h1>
    ${postList(list, { summary: true })}
    <p class="more"><a href="#/search?q=${enc(`#${tag} `)}">→ search within #${esc(tag)}</a> · <a href="#/tags">all tags</a></p>
  `;
}

async function renderPost(posts, slug, heading, token) {
  const i = posts.findIndex((p) => p.slug === slug);
  if (i < 0) return renderNotFound(`posts/${slug}`);
  const post = posts[i];
  setTitle(post.title);
  app.innerHTML = `<p class="muted">cat posts/${esc(slug)}/index.md …</p>`;

  let md;
  try {
    md = await fetchText(`posts/${enc(slug)}/index.md`);
  } catch (err) {
    if (token === navToken) renderError(err);
    return;
  }
  if (token !== navToken) return;

  const routeBase = `#/posts/${enc(slug)}`;
  const { fragment, toc } = renderMarkdown(md, { baseDir: `posts/${enc(slug)}/`, routeBase });
  const newer = posts[i - 1];
  const older = posts[i + 1];

  app.innerHTML = `
    <article class="post">
      <header class="post-header">
        <h1>${esc(post.title)}</h1>
        <p class="post-meta"><time datetime="${esc(post.date)}">${esc(post.date)}</time> · ${post.readingMinutes} min read</p>
        ${post.tags.length ? `<div class="tags">${post.tags.map((t) => tagLink(t)).join('')}</div>` : ''}
      </header>
      ${toc.length >= 2 ? `
        <details class="toc" open>
          <summary>tree -L 2</summary>
          <ul>${toc.map((h) => `<li class="lvl-${h.level}"><a href="${routeBase}?h=${enc(h.id)}" data-heading="${esc(h.id)}">${esc(h.text)}</a></li>`).join('')}</ul>
        </details>` : ''}
      <div class="content"></div>
      <nav class="pager" aria-label="More posts">
        ${older ? `<a class="prev" href="#/posts/${enc(older.slug)}"><span class="label">← older</span>${esc(older.title)}</a>` : ''}
        ${newer ? `<a class="next" href="#/posts/${enc(newer.slug)}"><span class="label">newer →</span>${esc(newer.title)}</a>` : ''}
      </nav>
    </article>
  `;
  app.querySelector('.content').append(fragment);
  if (heading) scrollToHeading(heading, false);
}

async function renderAbout(token) {
  setTitle('about');
  let md;
  try {
    md = await fetchText('about.md');
  } catch (err) {
    if (token === navToken) renderError(err);
    return;
  }
  if (token !== navToken) return;
  const { fragment } = renderMarkdown(md, { baseDir: '', routeBase: '#/about' });
  app.innerHTML = '<p class="cmd">cat about.md</p><article class="content"></article>';
  app.querySelector('.content').append(fragment);
}

function renderSearch(posts, query) {
  setTitle('search');
  app.innerHTML = `
    <p class="cmd">grep -ri</p>
    <div class="search-box">
      <label for="q">&gt;</label>
      <input id="q" type="search" autocomplete="off" spellcheck="false" placeholder="search posts…" value="${esc(query)}">
    </div>
    <p class="search-help muted">fuzzy match on title, tags and content · use <code>#tag</code> to filter, e.g. <code>#docker cache</code></p>
    <div id="results" aria-live="polite"></div>
  `;
  const input = app.querySelector('#q');
  const results = app.querySelector('#results');

  const show = (q) => {
    if (!q.trim()) {
      results.innerHTML = '';
      return;
    }
    const found = searchPosts(posts, q);
    results.innerHTML = `
      <p class="search-count">${found.length} result${found.length === 1 ? '' : 's'}</p>
      ${found.length ? postList(found, { summary: true }) : `<pre class="term"><span class="err">grep: no match for "${esc(q.trim())}"</span></pre>`}`;
  };

  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const q = input.value;
      history.replaceState(null, '', q.trim() ? `#/search?q=${enc(q)}` : '#/search');
      show(q);
    }, 120);
  });

  show(query);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function renderNotFound(path) {
  setTitle('not found');
  app.innerHTML = `
    <pre class="term">$ cd ${esc(path)}\n<span class="err">bash: cd: ${esc(path)}: No such file or directory</span></pre>
    <p><a href="#/">cd ~</a> · <a href="#/search">search</a></p>
  `;
}

function renderError(err) {
  setTitle('error');
  app.innerHTML = `
    <pre class="term"><span class="err">error: ${esc(err.message)}</span></pre>
    <p><button type="button" class="link-btn" data-action="retry">retry</button> · <a href="#/">cd ~</a></p>
  `;
}

// ---------- router ----------

async function route() {
  const token = ++navToken;
  const { parts, params } = parseHash();
  const [section, arg, ...rest] = parts;
  setActiveNav(section);

  const heading = params.get('h');
  if (!heading) window.scrollTo(0, 0);

  try {
    const { posts } = await loadIndex();
    if (token !== navToken) return;

    if (rest.length) renderNotFound(parts.join('/'));
    else if (!section) renderHome(posts);
    else if (section === 'posts' && !arg) renderPosts(posts);
    else if (section === 'posts') await renderPost(posts, arg, heading, token);
    else if (section === 'tags' && !arg) renderTags(posts);
    else if (section === 'tags') renderTag(posts, arg.toLowerCase());
    else if (section === 'search' && !arg) renderSearch(posts, params.get('q') ?? '');
    else if (section === 'about' && !arg) await renderAbout(token);
    else renderNotFound(parts.join('/'));
  } catch (err) {
    if (token === navToken) renderError(err);
  }
}

function scrollToHeading(id, smooth = true) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
}

// ---------- theme ----------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.getElementById('hljs-dark').disabled = theme === 'light';
  document.getElementById('hljs-light').disabled = theme !== 'light';
  try { localStorage.setItem('theme', theme); } catch { /* storage unavailable */ }
}

// ---------- wiring ----------

document.getElementById('theme-toggle').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
});

document.addEventListener('click', (e) => {
  const copy = e.target.closest('.copy-btn');
  if (copy) return void copyCode(copy);

  if (e.target.closest('[data-action="retry"]')) return void route();

  // In-page section links: scroll without triggering a re-render.
  const section = e.target.closest('a[data-heading]');
  if (section && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
    e.preventDefault();
    history.replaceState(null, '', section.getAttribute('href'));
    scrollToHeading(section.dataset.heading);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  e.preventDefault();
  if (location.hash.startsWith('#/search')) document.getElementById('q')?.focus();
  else location.hash = '#/search';
});

document.getElementById('year').textContent = new Date().getFullYear();
window.addEventListener('hashchange', route);
route();
