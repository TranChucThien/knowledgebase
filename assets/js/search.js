// Client-side search over posts.json using Fuse.js (global from index.html).
// Query syntax: free text is fuzzy-matched; "#tag" tokens filter by exact tag.

const FUSE_OPTIONS = {
  keys: [
    { name: 'title', weight: 3 },
    { name: 'tags', weight: 2 },
    { name: 'summary', weight: 1.5 },
    { name: 'text', weight: 1 },
  ],
  threshold: 0.35,
  ignoreLocation: true,
  minMatchCharLength: 2,
  // Each whitespace-separated word is fuzzy-matched independently (AND),
  // so "terraform lock" finds posts containing both words anywhere.
  useExtendedSearch: true,
};

const fuseCache = new WeakMap();

export function parseQuery(query) {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  return {
    tags: tokens.filter((t) => t.startsWith('#') && t.length > 1).map((t) => t.slice(1).toLowerCase()),
    text: tokens.filter((t) => !t.startsWith('#')).join(' '),
  };
}

export function searchPosts(posts, query) {
  const { tags, text } = parseQuery(query);
  if (!tags.length && !text) return [];

  const pool = tags.length ? posts.filter((p) => tags.every((t) => p.tags.includes(t))) : posts;
  if (!text) return pool;

  let fuse = pool === posts ? fuseCache.get(posts) : undefined;
  if (!fuse) {
    fuse = new Fuse(pool, FUSE_OPTIONS);
    if (pool === posts) fuseCache.set(posts, fuse);
  }
  return fuse.search(text).map((r) => r.item);
}
