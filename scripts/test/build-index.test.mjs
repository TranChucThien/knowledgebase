import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, renderFeed } from '../build-index.mjs';

function fixture(posts) {
  const root = mkdtempSync(join(tmpdir(), 'kb-'));
  for (const [slug, content] of Object.entries(posts)) {
    mkdirSync(join(root, 'posts', slug), { recursive: true });
    writeFileSync(join(root, 'posts', slug, 'index.md'), content);
  }
  return root;
}

const md = (title, date, extra = '') => `---\ntitle: ${title}\ndate: ${date}\n${extra}\n---\nBody of ${title}.\n`;

test('buildIndex sorts by date desc and skips drafts by default', () => {
  const root = fixture({
    old: md('Old', '2026-01-01'),
    new: md('New', '2026-05-01'),
    wip: md('Wip', '2026-06-01', 'draft: true'),
  });
  const { posts, errors } = buildIndex({ root });
  assert.deepEqual(errors, []);
  assert.deepEqual(posts.map((p) => p.slug), ['new', 'old']);
  assert.ok(!('draft' in posts[0]));
});

test('buildIndex includes drafts when asked', () => {
  const root = fixture({ wip: md('Wip', '2026-06-01', 'draft: true') });
  assert.deepEqual(buildIndex({ root, drafts: true }).posts.map((p) => p.slug), ['wip']);
});

test('buildIndex collects every error instead of stopping at the first', () => {
  const root = fixture({ a: md('', '2026-01-01'), b: md('B', 'nope'), ok: md('Ok', '2026-01-01') });
  const { errors } = buildIndex({ root });
  assert.equal(errors.length, 2);
});

test('buildIndex ignores folders without index.md', () => {
  const root = fixture({ ok: md('Ok', '2026-01-01') });
  mkdirSync(join(root, 'posts', 'empty'));
  assert.deepEqual(buildIndex({ root }).posts.map((p) => p.slug), ['ok']);
});

test('renderFeed escapes XML and links to hash routes', () => {
  const xml = renderFeed(
    [{ slug: 'a', title: 'A & <B>', date: '2026-01-02', summary: 's', tags: ['x'] }],
    'https://example.com/kb/',
  );
  assert.match(xml, /<title>A &amp; &lt;B&gt;<\/title>/);
  assert.match(xml, /<link>https:\/\/example\.com\/kb\/#\/posts\/a<\/link>/);
  assert.match(xml, /<category>x<\/category>/);
});
