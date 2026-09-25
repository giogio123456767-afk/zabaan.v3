# Zabaan — Kashmiri Archive

Cloudflare Worker + Static Assets project for the Zabaan Kashmiri language archive.

## Project structure

```text
zabaan/
├── public/
│   └── index.html
├── src/
│   └── worker.js
├── wrangler.toml
└── README.md
```

## Why the folders matter

`wrangler.toml` points Wrangler at `src/worker.js` and configures `public/` as the static-assets directory. Keep these paths exactly as shown.

## Cloudflare deployment

In Cloudflare Workers & Pages, connect this GitHub repository as a **Worker** project.

Use:

- Deploy command: `npx wrangler deploy`
- Build command: leave blank
- Root directory: `/` (repository root)

Do not move `index.html` out of `public/` or `worker.js` out of `src/`.

## Required Cloudflare setup

The Worker code expects:

- A KV namespace bound as `ZABAAN_KV`
- An encrypted Worker secret named `ADMIN_PASSWORD`

The KV namespace is used for the shared dictionary, plural-rule data, and contribution queue. The admin password protects writes and the contribution queue.

## Important

The demo entries in the website are explicitly placeholders. Replace them with verified, community-sourced Kashmiri data before treating entries as authoritative.
