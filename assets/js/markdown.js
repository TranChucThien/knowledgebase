// Markdown → sanitized DOM, plus the post-processing a post page needs:
// relative URL rewriting, heading ids + TOC data, code highlighting and copy buttons.
// Relies on the globals loaded in index.html: marked, DOMPurify, hljs.

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i;
const SIBLING_POST = /^\.\.\/([a-z0-9][a-z0-9-]*)\/?(?:index\.md)?(?:#(.*))?$/;

export const stripFrontMatter = (src) => src.replace(FRONT_MATTER, '');

// GitHub-style heading slugs, so authors can write [link](#my-heading) as usual.
export const slugify = (text) =>
  text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');

const sectionHref = (routeBase, id) => `${routeBase}?h=${encodeURIComponent(id)}`;

/**
 * @param {string} src        raw markdown (front matter allowed)
 * @param {object} opts
 * @param {string} opts.baseDir    directory the .md lives in, e.g. "posts/my-post/"
 * @param {string} opts.routeBase  hash route of the page, e.g. "#/posts/my-post"
 * @returns {{ fragment: DocumentFragment, toc: {id: string, text: string, level: number}[] }}
 */
export function renderMarkdown(src, { baseDir = '', routeBase }) {
  const tpl = document.createElement('template');
  tpl.innerHTML = DOMPurify.sanitize(marked.parse(stripFrontMatter(src), { gfm: true }));
  const root = tpl.content;

  rewriteUrls(root, baseDir, routeBase);
  const toc = addHeadingIds(root, routeBase);
  decorateCode(root);
  return { fragment: root, toc };
}

function rewriteUrls(root, baseDir, routeBase) {
  for (const img of root.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (!ABSOLUTE_URL.test(src)) img.setAttribute('src', baseDir + src);
    img.loading = 'lazy';
  }

  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    const sibling = href.match(SIBLING_POST);
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1));
      a.setAttribute('href', sectionHref(routeBase, id));
      a.dataset.heading = id;
    } else if (sibling) {
      // ../other-post/ or ../other-post/index.md links between posts
      a.setAttribute('href', `#/posts/${sibling[1]}${sibling[2] ? `?h=${encodeURIComponent(sibling[2])}` : ''}`);
    } else if (!ABSOLUTE_URL.test(href)) {
      a.setAttribute('href', baseDir + href);
    } else if (/^https?:/i.test(href)) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  }
}

function addHeadingIds(root, routeBase) {
  const seen = new Map();
  const toc = [];
  for (const h of root.querySelectorAll('h2, h3')) {
    const base = slugify(h.textContent) || 'section';
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const id = n ? `${base}-${n}` : base;
    toc.push({ id, text: h.textContent.trim(), level: Number(h.tagName[1]) });

    h.id = id;
    const anchor = document.createElement('a');
    anchor.className = 'anchor';
    anchor.href = sectionHref(routeBase, id);
    anchor.dataset.heading = id;
    anchor.setAttribute('aria-label', `Link to section: ${h.textContent.trim()}`);
    anchor.textContent = '#';
    h.append(anchor);
  }
  return toc;
}

function decorateCode(root) {
  for (const code of root.querySelectorAll('pre > code')) {
    const pre = code.parentElement;
    const lang = [...code.classList].find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? '';
    if (lang && window.hljs?.getLanguage(lang)) hljs.highlightElement(code);

    const block = document.createElement('div');
    block.className = 'code-block';
    block.innerHTML = `
      <div class="code-bar">
        <span class="dots" aria-hidden="true"></span>
        <span class="lang"></span>
        <button type="button" class="copy-btn" aria-label="Copy code">copy</button>
      </div>`;
    block.querySelector('.lang').textContent = lang;
    pre.replaceWith(block);
    block.append(pre);
  }
}

/** Click handler for .copy-btn (wired up once via event delegation). */
export async function copyCode(button) {
  const code = button.closest('.code-block')?.querySelector('pre code');
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code.textContent);
    flash(button, 'copied!');
  } catch {
    // Clipboard API unavailable (e.g. plain http) — select the text so ctrl+c works.
    const range = document.createRange();
    range.selectNodeContents(code);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    flash(button, 'press ctrl+c');
  }
}

function flash(button, text) {
  button.textContent = text;
  button.classList.add('copied');
  setTimeout(() => {
    button.textContent = 'copy';
    button.classList.remove('copied');
  }, 1500);
}
