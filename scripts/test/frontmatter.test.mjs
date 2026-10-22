import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontMatter, splitFrontMatter, toPost, markdownToText } from '../lib/posts.mjs';

test('splitFrontMatter separates the yaml block from the body', () => {
  const { raw, body } = splitFrontMatter('---\ntitle: Hi\n---\n# Body\n', 'a.md');
  assert.equal(raw, 'title: Hi');
  assert.equal(body, '# Body\n');
});

test('splitFrontMatter fails without a front matter block', () => {
  assert.throws(() => splitFrontMatter('# no front matter', 'a.md'), /a\.md: missing front matter/);
});

test('parseFrontMatter handles strings, quotes, booleans and inline arrays', () => {
  const fm = parseFrontMatter(
    [
      'title: "Hello: world"',
      "summary: 'single quoted'",
      'plain: unquoted value',
      'draft: true',
      'tags: ["Docker", " linux ", ci-cd]',
      'empty: []',
      '# comment line',
    ].join('\n'),
    'a.md',
  );
  assert.deepEqual(fm, {
    title: 'Hello: world',
    summary: 'single quoted',
    plain: 'unquoted value',
    draft: true,
    tags: ['Docker', ' linux ', 'ci-cd'], // quoted whitespace kept; toPost trims
    empty: [],
  });
});

test('parseFrontMatter reports file and line for unsupported syntax', () => {
  assert.throws(() => parseFrontMatter('title: ok\n  - nested', 'p.md'), /p\.md:3: unsupported front matter/);
});

test('parseFrontMatter rejects unterminated arrays and quotes', () => {
  assert.throws(() => parseFrontMatter('tags: [a, b', 'p.md'), /p\.md:2: unterminated array/);
  assert.throws(() => parseFrontMatter('title: "oops', 'p.md'), /p\.md:2: unterminated quote/);
});

const doc = (fm, body = 'Some **body** text.') => `---\n${fm}\n---\n${body}\n`;

test('toPost builds a normalized post', () => {
  const post = toPost('my-post', doc('title: My Post\ndate: 2026-10-01\ntags: ["Docker", "docker", "K8s"]'), 'x.md');
  assert.equal(post.slug, 'my-post');
  assert.equal(post.title, 'My Post');
  assert.equal(post.date, '2026-10-01');
  assert.deepEqual(post.tags, ['docker', 'k8s']);
  assert.equal(post.summary, 'Some body text.');
  assert.equal(post.readingMinutes, 1);
  assert.equal(post.draft, false);
});

test('toPost requires title and a valid date', () => {
  assert.throws(() => toPost('a', doc('date: 2026-10-01'), 'x.md'), /x\.md: "title" is required/);
  assert.throws(() => toPost('a', doc('title: T'), 'x.md'), /x\.md: "date" must be YYYY-MM-DD/);
  assert.throws(() => toPost('a', doc('title: T\ndate: 2026-13-45'), 'x.md'), /"date" must be YYYY-MM-DD/);
});

test('toPost rejects invalid slugs and non-array tags', () => {
  assert.throws(() => toPost('Bad Slug', doc('title: T\ndate: 2026-10-01'), 'x.md'), /invalid folder name/);
  assert.throws(() => toPost('a', doc('title: T\ndate: 2026-10-01\ntags: docker'), 'x.md'), /"tags" must be an array/);
});

test('toPost keeps an explicit summary and reads draft flag', () => {
  const post = toPost('a', doc('title: T\ndate: 2026-10-01\nsummary: Short.\ndraft: true'), 'x.md');
  assert.equal(post.summary, 'Short.');
  assert.equal(post.draft, true);
});

test('markdownToText strips markdown syntax', () => {
  const md = '# Title\n\nSee [docs](http://x) and ![diagram](a.png).\n\n```bash\necho hi\n```\n\n- `code` item\n> quote';
  assert.equal(markdownToText(md), 'Title See docs and diagram. echo hi code item quote');
  assert.equal(markdownToText(md, { code: false }), 'Title See docs and diagram. code item quote');
});
