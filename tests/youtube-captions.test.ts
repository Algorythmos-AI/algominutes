import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// Captions that exist but can't be parsed must fail loudly, not look like a
// video with no captions (the old parser swallowed JSON errors as '').
const require = createRequire(import.meta.url);
const { parseSubtitles } = require('../services/extractor/src/extractors/youtube.js');

describe('youtube caption parsing', () => {
  it('parses json3 captions into lines', () => {
    const raw = JSON.stringify({ events: [{ segs: [{ utf8: 'hello ' }, { utf8: 'world' }] }, { segs: [{ utf8: 'second line' }] }] });
    expect(parseSubtitles('talk.en.json3', raw)).toBe('hello world\nsecond line');
  });

  it('strips VTT markup completely, even when tags are nested to survive one pass', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<c.colorE5E5E5>hello</c> <00:00:01.500><c>world</c>\n\n00:00:03.000 --> 00:00:04.000\n<scr<script>ipt>alert(1)</script> fine';
    const out = parseSubtitles('talk.en.vtt', vtt);
    expect(out).toBe('hello world\nalert(1) fine');
    expect(out).not.toMatch(/[<>]/);
  });

  it('rejects malformed json3 as YOUTUBE_CAPTIONS_MALFORMED, not as "no captions"', () => {
    let caught: any;
    try { parseSubtitles('talk.en.json3', '{"events": [ {"segs": '); } catch (err) { caught = err; }
    expect(caught?.code).toBe('YOUTUBE_CAPTIONS_MALFORMED');
    expect(caught?.isPermanent).toBe(true);
    expect(caught?.message).toMatch(/^youtube_captions_malformed: /);
  });
});
