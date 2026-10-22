// Parsing and validation for posts/<slug>/index.md files.
// Front matter supports a deliberately small YAML subset:
//   key: value            (unquoted, "double" or 'single' quoted string)
//   key: true | false
//   key: [a, "b", 'c']    (inline array; items cannot contain commas)

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SUMMARY_LENGTH = 160;
const WORDS_PER_MINUTE = 200;

export function splitFrontMatter(src, file) {
  const m = src.match(FRONT_MATTER);
  if (!m) throw new Error(`${file}: missing front matter (a --- block at the top of the file)`);
  return { raw: m[1], body: src.slice(m[0].length) };
}

export function parseFrontMatter(raw, file) {
  const data = {};
  raw.split(/\r?\n/).forEach((line, i) => {
    const where = `${file}:${i + 2}`; // +1 for 1-based, +1 for the opening ---
    if (!line.trim() || line.trimStart().startsWith('#')) return;
    const m = line.match(/^([A-Za-z_][\w-]*):(?:\s+(.*))?$/);
    if (!m) throw new Error(`${where}: unsupported front matter syntax: ${line.trim()}`);
    data[m[1]] = parseValue((m[2] ?? '').trim(), where);
  });
  return data;
}

function parseValue(value, where) {
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw new Error(`${where}: unterminated array`);
    const inner = value.slice(1, -1).trim();
    return inner ? inner.split(',').map((item) => unquote(item.trim(), where)) : [];
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  return unquote(value, where);
}

function unquote(value, where) {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return value;
  if (value.length < 2 || !value.endsWith(quote)) throw new Error(`${where}: unterminated quote`);
  return value.slice(1, -1);
}

export function markdownToText(md, { code = true } = {}) {
  return md
    .replace(/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm, (_, _fence, body) => (code ? body : ' '))
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/`+/g, '')
    .replace(/(\*\*|__|\*|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : max)}…`;
}

function isValidDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

export function toPost(slug, src, file) {
  if (!SLUG.test(slug)) {
    throw new Error(`${file}: invalid folder name "${slug}" (use lowercase letters, digits and dashes)`);
  }
  const { raw, body } = splitFrontMatter(src, file);
  const fm = parseFrontMatter(raw, file);

  if (typeof fm.title !== 'string' || !fm.title.trim()) throw new Error(`${file}: "title" is required`);
  if (!isValidDate(fm.date)) throw new Error(`${file}: "date" must be YYYY-MM-DD (got ${JSON.stringify(fm.date)})`);
  if (fm.tags !== undefined && !Array.isArray(fm.tags)) {
    throw new Error(`${file}: "tags" must be an array, e.g. tags: ["docker", "linux"]`);
  }

  const tags = [...new Set((fm.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))];
  const text = markdownToText(body);
  const words = text ? text.split(' ').length : 0;

  return {
    slug,
    title: fm.title.trim(),
    date: fm.date,
    tags,
    summary: typeof fm.summary === 'string' && fm.summary.trim()
      ? fm.summary.trim()
      : truncate(markdownToText(body, { code: false }), SUMMARY_LENGTH),
    readingMinutes: Math.max(1, Math.ceil(words / WORDS_PER_MINUTE)),
    draft: fm.draft === true,
    text,
  };
}
