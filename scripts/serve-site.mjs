#!/usr/bin/env node
// Serves apps/site/dist the way Vercel does, from apps/site/vercel.json: its
// headers, cleanUrls, rewrites and 404 page. The site's browser tests run
// against it, so the CSP and headers are exercised against the real pages
// before a deploy; scripts/smoke-site.mjs then checks the real host.
//
//   node scripts/serve-site.mjs [port]      (default 4322)
//
// Only the parts of vercel.json the site uses are implemented; an unknown key
// fails loudly rather than being silently ignored.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'apps/site');
const KNOWN_KEYS = new Set(['$schema', 'framework', 'buildCommand', 'outputDirectory', 'cleanUrls', 'trailingSlash', 'rewrites', 'headers']);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

/** A vercel.json `source` (path-to-regexp with regex groups) as a RegExp. */
export function sourceRegex(source) {
  const body = source
    .replace(/:(\w+)\*/g, '(?<$1>.*)')
    .replace(/:(\w+)(?![\w*(])/g, '(?<$1>[^/]+)');
  return new RegExp(`^${body}$`);
}

export function loadConfig(file = path.join(SITE, 'vercel.json')) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`serve-site: vercel.json key "${key}" isn't emulated; add it here first`);
  }
  return config;
}

/** The response headers vercel.json gives `pathname`: every matching rule, later rules overriding earlier ones. */
export function headersFor(config, pathname) {
  const out = {};
  for (const rule of config.headers || []) {
    if (sourceRegex(rule.source).test(pathname)) for (const h of rule.headers) out[h.key] = h.value;
  }
  return out;
}

/**
 * The deployed filesystem: request path → file. With cleanUrls, Vercel serves
 * `x.html` only at `/x` (and `index.html` at `/`), so `/x.html` is not a path
 * a rewrite can reach (vercel/vercel builder-orchestration writeStaticFile).
 */
export function servedPaths(config, dist) {
  const out = new Map();
  for (const rel of fs.readdirSync(dist, { recursive: true })) {
    const file = path.join(dist, rel);
    if (!fs.statSync(file).isFile()) continue;
    let route = `/${String(rel).split(path.sep).join('/')}`;
    if (config.cleanUrls && route.endsWith('.html')) route = route.slice(0, -5).replace(/(^|\/)index$/, '') || '/';
    out.set(route, file);
  }
  return out;
}

/**
 * What Vercel does with `pathname`: { redirect } or { file, status }. The order
 * is @vercel/routing-utils': the cleanUrls and trailingSlash redirects (which
 * end routing, so they carry none of the custom headers), then the filesystem,
 * then rewrites, then the 404 page.
 */
export function resolve(config, dist, pathname, served = servedPaths(config, dist)) {
  if (config.cleanUrls) {
    const index = /^\/(?:(.+)\/)?index(?:\.html)?\/?$/.exec(pathname);
    if (index) return { redirect: `/${index[1] ?? ''}` };
    const html = /^\/(.*)\.html\/?$/.exec(pathname);
    if (html) return { redirect: `/${html[1]}` };
  }
  if (config.trailingSlash === false && pathname.length > 1 && pathname.endsWith('/')) {
    return { redirect: pathname.replace(/\/+$/, '') };
  }
  if (served.has(pathname)) return { file: served.get(pathname), status: 200 };
  for (const rule of config.rewrites || []) {
    if (!sourceRegex(rule.source).test(pathname)) continue;
    if (config.cleanUrls && rule.destination.endsWith('.html')) {
      throw new Error(`serve-site: rewrite ${rule.source} → ${rule.destination}: with cleanUrls on, Vercel serves no .html path; use ${rule.destination.slice(0, -5)}`);
    }
    if (!served.has(rule.destination)) throw new Error(`serve-site: rewrite ${rule.source} → ${rule.destination}, which the deployment doesn't serve`);
    return { file: served.get(rule.destination), status: 200 };
  }
  return { file: served.get(config.cleanUrls ? '/404' : '/404.html') ?? null, status: 404 };
}

export function createServer({ config = loadConfig(), dist = path.join(SITE, config.outputDirectory || 'dist') } = {}) {
  return http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const r = resolve(config, dist, pathname);
    if (r.redirect) {
      res.writeHead(308, { Location: r.redirect });
      res.end();
      return;
    }
    const headers = headersFor(config, pathname);
    if (!r.file) {
      res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(r.status, { ...headers, 'Content-Type': TYPES[path.extname(r.file)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(r.file));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.argv[2] || 4322);
  createServer().listen(port, () => process.stdout.write(`serving apps/site/dist on http://localhost:${port}\n`));
}
