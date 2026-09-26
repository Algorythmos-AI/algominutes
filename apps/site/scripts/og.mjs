#!/usr/bin/env node
// Renders public/og.png (1200×630, the link-preview image) from the brand mark
// and tokens. Re-run after a brand change:  node apps/site/scripts/og.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const tokens = JSON.parse(fs.readFileSync(path.join(root, 'packages/tokens/tokens.json'), 'utf8'));
const m = tokens.brand.mark;
const icon = fs.readFileSync(path.join(root, 'apps/ios/brand/icon-rounded.svg'), 'utf8');

const html = `<!doctype html><html><body style="margin:0">
<div style="width:1200px;height:630px;box-sizing:border-box;padding:0 96px;display:flex;align-items:center;gap:64px;
  background:${m.navy};font-family:${tokens.typography.fontFamily.heading}">
  <div style="width:260px;height:260px;flex:none">${icon.replace('<svg ', '<svg style="width:260px;height:260px" ')}</div>
  <div>
    <div style="font-size:88px;font-weight:800;letter-spacing:-0.02em;color:#fff;line-height:1">Algo<span style="color:${m.lavender}">Minutes</span></div>
    <div style="margin-top:28px;font-size:44px;font-weight:600;color:#fff;line-height:1.2">Every meeting, summed up.</div>
    <div style="margin-top:18px;font-size:30px;color:${m.lavender}">Summaries, decisions and action items.</div>
  </div>
</div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html);
await page.screenshot({ path: path.join(here, '../public/og.png') });
await browser.close();
