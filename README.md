# knowledgebase

Personal technical blog → **https://tranchucthien.github.io/knowledgebase/**

Pure static site: `index.html` + vanilla JS renders Markdown posts in the browser.
No framework, no `npm install`. A tiny Node script builds the post index.

## Write a post

```bash
node scripts/new-post.mjs "My post title" --tags docker,linux
# → posts/my-post-title/index.md  (draft: true)
```

Front matter:

```yaml
---
title: "My post title"
date: 2026-10-22
tags: ["docker", "linux"]
summary: "Shown in lists and search results (optional)."
draft: false        # true = only visible locally with --drafts
---
```

Put images next to `index.md` and reference them relatively: `![diagram](diagram.png)`.
Link to another post with `[text](../other-post/)`.

## Preview locally

```bash
node scripts/build-index.mjs --drafts   # re-run after adding/editing front matter
python3 -m http.server 8000             # http://localhost:8000
```

Editing a post body only needs a browser refresh; changing front matter needs the index rebuilt.

## Publish

```bash
git add posts/my-post-title && git commit -m "post: my post title" && git push
```

GitHub Actions runs the tests, builds `posts.json` + `feed.xml` and deploys to Pages.
A post with invalid front matter fails the build, so nothing broken gets published.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Layout

```
index.html               app shell
assets/css/main.css      styles (dark/light)
assets/js/app.js         hash router + pages
assets/js/markdown.js    markdown rendering, TOC, code blocks
assets/js/search.js      Fuse.js search
posts/<slug>/index.md    posts
about.md                 about page
scripts/                 build-index, new-post, tests (node --test scripts/test/)
```
