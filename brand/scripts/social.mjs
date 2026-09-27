#!/usr/bin/env node
// Renders the brand kit's raster images from the generated SVGs, the tokens and
// the Geist fonts, in headless Chromium:
//   brand/logo/png/*.png         every logo SVG, transparent, at its drawing size
//   brand/social/*.png           the link preview and the X, LinkedIn and YouTube images
//   apps/site/public/og.png      the site's link preview (the same as og-1200x630)
//   brand/social/brand-reveal-*.mp4   a 6 s reveal, frame by frame (needs ffmpeg)
//
// Run after `swift brand/scripts/generate.swift`, from the repo root:
//   node brand/scripts/social.mjs            everything
//   node brand/scripts/social.mjs --no-video skip the videos
// Playwright comes with apps/site (npm ci at the root installs it).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const brand = path.resolve(here, '..');
const root = path.resolve(brand, '..');
const tokens = JSON.parse(fs.readFileSync(path.join(root, 'packages/tokens/tokens.json'), 'utf8'));
const m = tokens.brand.mark;
const read = (p) => fs.readFileSync(path.join(brand, p));
const dataURI = (p, type) => `data:${type};base64,${read(p).toString('base64')}`;
const rel = (p) => path.relative(root, p);

// MARK: - The look

const fonts = ['Regular', 'Medium', 'SemiBold', 'Bold']
  .map((w, i) => `@font-face{font-family:Geist;font-weight:${400 + i * 100};src:url(${dataURI(`fonts/Geist-${w}.otf`, 'font/otf')})}`)
  .join('');
const icon = read('icon/icon-rounded.svg').toString();
const wordmark = dataURI('logo/wordmark-on-dark.svg', 'image/svg+xml');

/** A voice waveform: a few sines under a bell envelope, so it swells in the middle. */
function waveform(w, h, seed = 1) {
  const pts = [];
  for (let i = 0; i <= 240; i++) {
    const x = i / 240;
    const env = Math.exp(-((x - 0.5) ** 2) / 0.045);
    const y = Math.sin(x * 38 + seed) * 0.55 + Math.sin(x * 91 + seed * 2) * 0.3 + Math.sin(x * 17) * 0.15;
    pts.push(`${(x * w).toFixed(1)},${(h / 2 - y * env * h * 0.42).toFixed(1)}`);
  }
  return `<svg class="wave" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none">
    <defs><linearGradient id="wg" x1="0" x2="1"><stop offset="0" stop-color="${m.gradientEnd}" stop-opacity="0"/>
      <stop offset="0.3" stop-color="${m.gradientEnd}"/><stop offset="0.5" stop-color="${m.lavender}"/>
      <stop offset="0.7" stop-color="${m.gradientStart}"/><stop offset="1" stop-color="${m.gradientStart}" stop-opacity="0"/></linearGradient>
      <filter id="wglow"><feGaussianBlur stdDeviation="6"/></filter></defs>
    <polyline class="draw" points="${pts.join(' ')}" fill="none" stroke="url(#wg)" stroke-width="10" opacity="0.55" filter="url(#wglow)"/>
    <polyline class="draw" points="${pts.join(' ')}" fill="none" stroke="url(#wg)" stroke-width="2.5" stroke-linecap="round"/>
  </svg>`;
}

const css = (w, h) => `${fonts}
  *{box-sizing:border-box;margin:0}
  html,body{width:${w}px;height:${h}px;overflow:hidden}
  body{background:${m.space};font-family:Geist,sans-serif;color:#fff;position:relative}
  .aurora{position:absolute;inset:0;background:
    radial-gradient(60% 90% at 8% 0%, ${m.gradientStart}E6 0%, transparent 70%),
    radial-gradient(55% 80% at 100% 100%, ${m.gradientEnd}BF 0%, transparent 70%),
    radial-gradient(30% 45% at 78% 30%, ${m.auroraMagenta}59 0%, transparent 70%)}
  .grid{position:absolute;inset:0;background-image:linear-gradient(#ffffff0d 1px,transparent 1px),linear-gradient(90deg,#ffffff0d 1px,transparent 1px);
    background-size:40px 40px;-webkit-mask-image:radial-gradient(ellipse 70% 70% at 50% 50%,#000 30%,transparent 100%)}
  .wave{position:absolute;left:0;width:100%}
  .icon{position:relative;flex:none;filter:drop-shadow(0 30px 60px ${m.gradientEnd}8C)}
  .icon svg{width:100%;height:100%;display:block}
  .glow{position:absolute;inset:-18%;background:radial-gradient(circle, ${m.gradientEnd}73 0%, transparent 65%);filter:blur(20px)}
  .word{display:block}
  .tag{font-weight:600;letter-spacing:-0.02em;line-height:1.1;background:linear-gradient(90deg,#fff,${m.lavender});
    -webkit-background-clip:text;background-clip:text;color:transparent}
  .sub{color:${m.lavender};opacity:.85;font-weight:400;letter-spacing:-0.005em}
  .chip{display:inline-block;border:1px solid #ffffff2e;background:#ffffff12;border-radius:999px;color:#E4DCFF;
    font-weight:600;letter-spacing:.34em;text-transform:uppercase;backdrop-filter:blur(8px)}
  .row{position:absolute;display:flex;align-items:center}
  .col{display:flex;flex-direction:column}`;

/** One composition: the icon, then the wordmark, tagline, line and chip. `u` scales the type;
 * `centre` centres the group on x; `stack` puts the icon above the text. */
function scene({ w, h, u, iconSize, x, y, align = 'left', centre = align === 'center', stack = false, wave, chip = true, sub = true, tag = true }) {
  const text = `<div class="col" style="align-items:${align === 'center' ? 'center' : 'flex-start'};text-align:${align};white-space:nowrap;gap:${14 * u}px">
      <img class="word" src="${wordmark}" style="height:${58 * u}px;margin-bottom:${6 * u}px">
      ${tag ? `<div class="tag" style="font-size:${40 * u}px">Every meeting, summed up.</div>` : ''}
      ${sub ? `<div class="sub" style="font-size:${26 * u}px">Summaries, decisions and action items.</div>` : ''}
      ${chip ? `<div class="chip" style="font-size:${13 * u}px;padding:${8 * u}px ${16 * u}px;margin-top:${6 * u}px">By Algorythmos</div>` : ''}
    </div>`;
  return `<!doctype html><html><head><style>${css(w, h)}</style></head><body>
    <div class="aurora"></div><div class="grid"></div>
    ${wave ? `<div style="position:absolute;left:0;right:0;top:${wave.y}px;height:${wave.h}px">${waveform(w, wave.h, wave.seed ?? 1)}</div>` : ''}
    <div class="row" style="left:${x}px;top:${y}px;gap:${(stack ? 36 : 48) * u}px;flex-direction:${stack ? 'column' : 'row'};transform:translate(${centre ? '-50%' : '0'},-50%)">
      <div class="icon" style="width:${iconSize}px;height:${iconSize}px"><div class="glow"></div>${icon}</div>
      ${text}
    </div></body></html>`;
}

// Where an avatar or a crop sits on each network, the text keeps clear of it.
const social = [
  { file: 'og-1200x630.png', w: 1200, h: 630, u: 1, iconSize: 260, x: 96, y: 290, wave: { y: 470, h: 160 } },
  // X: the profile photo overlaps the header's bottom-left.
  { file: 'x-header-1500x500.png', w: 1500, h: 500, u: 1.05, iconSize: 220, x: 520, y: 215, wave: { y: 370, h: 130, seed: 2 } },
  // LinkedIn company page: the logo overlaps the left; the banner is shallow.
  { file: 'linkedin-banner-1128x191.png', w: 1128, h: 191, u: 0.62, iconSize: 118, x: 360, y: 88, sub: false, chip: false, wave: { y: 152, h: 39, seed: 3 } },
  // LinkedIn profile cover: the photo overlaps the bottom-left.
  { file: 'linkedin-cover-1584x396.png', w: 1584, h: 396, u: 0.85, iconSize: 190, x: 560, y: 175, wave: { y: 290, h: 106, seed: 4 } },
  // YouTube: everything inside the 1546 x 423 area every device shows.
  { file: 'youtube-banner-2560x1440.png', w: 2560, h: 1440, u: 1.35, iconSize: 330, x: 507 + 90, y: 720, wave: { y: 900, h: 300, seed: 5 } },
];

// MARK: - Render

const browser = await chromium.launch();
async function shoot(html, w, h, out, { transparent = false } = {}) {
  const page = await browser.newPage({ viewport: { width: Math.round(w), height: Math.round(h) } });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out, omitBackground: transparent });
  await page.close();
  console.log(`wrote ${rel(out)}`);
}

fs.mkdirSync(path.join(brand, 'logo/png'), { recursive: true });
for (const f of fs.readdirSync(path.join(brand, 'logo')).filter((f) => f.endsWith('.svg')).sort()) {
  const svg = read(`logo/${f}`).toString();
  const [, w, h] = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/).map(Number);
  const html = `<!doctype html><html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg style="display:block" ')}</body></html>`;
  await shoot(html, w, h, path.join(brand, 'logo/png', f.replace('.svg', '.png')), { transparent: true });
}

fs.mkdirSync(path.join(brand, 'social'), { recursive: true });
for (const s of social) await shoot(scene(s), s.w, s.h, path.join(brand, 'social', s.file));
fs.copyFileSync(path.join(brand, 'social/og-1200x630.png'), path.join(root, 'apps/site/public/og.png'));
console.log('wrote apps/site/public/og.png');

// MARK: - The reveal (frame by frame, so it's smooth and the same every run)

function reveal(w, h) {
  const square = w === h;
  const s = square
    ? { w, h, u: 1.1, iconSize: 320, x: w / 2, y: h * 0.44, align: 'center', stack: true, wave: { y: h * 0.8, h: 200 } }
    : { w, h, u: 1.6, iconSize: 380, x: w / 2, y: h * 0.45, centre: true, wave: { y: h * 0.72, h: 280 } };
  const html = scene(s);
  const anim = `<style>
    .aurora{animation:fade 1.2s ease-out both}
    .grid{animation:fade 1.6s .2s ease-out both}
    .draw{stroke-dasharray:4000;stroke-dashoffset:4000;animation:draw 1.8s .5s cubic-bezier(.6,0,.2,1) both}
    .icon{animation:rise 1.2s 1.1s cubic-bezier(.2,.8,.2,1) both}
    .word{animation:wipe 1.1s 2.1s cubic-bezier(.6,0,.2,1) both}
    .tag{animation:up .9s 2.9s ease-out both}
    .sub{animation:up .9s 3.3s ease-out both}
    .chip{animation:up .9s 3.7s ease-out both}
    .icon circle[fill^="url"]{transform-box:fill-box;transform-origin:center;animation:pulse 1.4s 3s ease-in-out 2}
    @keyframes fade{from{opacity:0}}
    @keyframes draw{to{stroke-dashoffset:0}}
    @keyframes rise{from{opacity:0;transform:translateY(60px) scale(.88)}}
    @keyframes wipe{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
    @keyframes up{from{opacity:0;transform:translateY(18px)}}
    @keyframes pulse{50%{transform:scale(1.12)}}
  </style>`;
  return html.replace('</head>', `${anim}</head>`);
}

async function video(w, h, out, seconds = 6, fps = 30) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reveal-'));
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.setContent(reveal(w, h), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => document.getAnimations().forEach((a) => a.pause()));
  for (let f = 0; f < seconds * fps; f++) {
    await page.evaluate((t) => document.getAnimations().forEach((a) => { a.currentTime = t; }), (f * 1000) / fps);
    await page.screenshot({ path: path.join(dir, `f${String(f).padStart(4, '0')}.png`) });
  }
  await page.close();
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(dir, 'f%04d.png'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', out]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`wrote ${rel(out)}`);
}

if (!process.argv.includes('--no-video')) {
  await video(1920, 1080, path.join(brand, 'social/brand-reveal-1920x1080.mp4'));
  await video(1080, 1080, path.join(brand, 'social/brand-reveal-1080x1080.mp4'));
}
await browser.close();
