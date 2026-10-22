#!/usr/bin/env node
// Scaffolds posts/<slug>/index.md as a draft.
//
//   node scripts/new-post.mjs "My post title" [--tags docker,linux] [--slug custom-slug]

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const slugify = (s) =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const argv = process.argv.slice(2);
const title = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
if (!title) {
  console.error('Usage: node scripts/new-post.mjs "Post title" [--tags a,b] [--slug my-slug]');
  process.exit(1);
}

const slug = flag(argv, '--slug') ?? slugify(title);
const tags = (flag(argv, '--tags') ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
const dir = join(ROOT, 'posts', slug);
const file = join(dir, 'index.md');

if (!slug) {
  console.error('Could not derive a slug from the title; pass --slug');
  process.exit(1);
}
if (existsSync(file)) {
  console.error(`${relative(ROOT, file)} already exists`);
  process.exit(1);
}

mkdirSync(dir, { recursive: true });
writeFileSync(
  file,
  `---
title: "${title.replace(/"/g, "'")}"
date: ${today()}
tags: [${tags.map((t) => `"${t}"`).join(', ')}]
summary: ""
draft: true
---

Write your post here. Put images next to this file and reference them as ![alt](image.png).
`,
);
console.log(`✓ created ${relative(ROOT, file)} (draft: true — set to false to publish)`);
