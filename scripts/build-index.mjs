#!/usr/bin/env node
// Generates posts.json (list + search index) and feed.xml from posts/<slug>/index.md.
//
//   node scripts/build-index.mjs [--drafts] [--site-url https://example.com/kb/]

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { toPost } from './lib/posts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SITE_URL = 'https://tranchucthien.github.io/knowledgebase/';
const FEED_SIZE = 20;

export function buildIndex({ root = ROOT, drafts = false } = {}) {
  const postsDir = join(root, 'posts');
  const posts = [];
  const errors = [];

  const slugs = existsSync(postsDir)
    ? readdirSync(postsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];

  for (const slug of slugs) {
    const file = join(postsDir, slug, 'index.md');
    if (!existsSync(file)) continue;
    try {
      const { draft, ...post } = toPost(slug, readFileSync(file, 'utf8'), relative(root, file));
      if (!draft || drafts) posts.push(post);
    } catch (err) {
      errors.push(err.message);
    }
  }

  posts.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  return { posts, errors };
}

const xml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

export function renderFeed(posts, siteUrl) {
  const items = posts.slice(0, FEED_SIZE).map((p) => {
    const link = `${siteUrl}#/posts/${p.slug}`;
    return [
      '    <item>',
      `      <title>${xml(p.title)}</title>`,
      `      <link>${xml(link)}</link>`,
      `      <guid>${xml(link)}</guid>`,
      `      <pubDate>${new Date(`${p.date}T00:00:00Z`).toUTCString()}</pubDate>`,
      `      <description>${xml(p.summary)}</description>`,
      ...p.tags.map((t) => `      <category>${xml(t)}</category>`),
      '    </item>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '  <channel>',
    '    <title>tranchucthien — knowledgebase</title>',
    `    <link>${xml(siteUrl)}</link>`,
    '    <description>Technical notes on DevOps, cloud and software engineering.</description>',
    '    <language>en-us</language>',
    ...items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

function main(argv) {
  const drafts = argv.includes('--drafts');
  const urlFlag = argv.indexOf('--site-url');
  let siteUrl = urlFlag >= 0 ? argv[urlFlag + 1] : DEFAULT_SITE_URL;
  if (!siteUrl) {
    console.error('--site-url needs a value');
    return 1;
  }
  if (!siteUrl.endsWith('/')) siteUrl += '/';

  const { posts, errors } = buildIndex({ drafts });
  if (errors.length) {
    console.error(`✗ ${errors.length} post(s) have errors:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    return 1;
  }

  const index = { generated: new Date().toISOString(), posts };
  writeFileSync(join(ROOT, 'posts.json'), `${JSON.stringify(index, null, 2)}\n`);
  writeFileSync(join(ROOT, 'feed.xml'), renderFeed(posts, siteUrl));
  console.log(`✓ ${posts.length} post(s) → posts.json, feed.xml${drafts ? ' (drafts included)' : ''}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
