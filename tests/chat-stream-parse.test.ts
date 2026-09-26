import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// A stream event that doesn't parse (the connection dropped mid-event) is logged,
// but never with the payload or Node's message: both quote the model's answer.
const require = createRequire(import.meta.url);
const { parseSseDataLine } = require('../services/api/src/routes/search-and-chat.cjs');

describe('parseSseDataLine', () => {
  it("a cut-off event reports only the error's name and the length", () => {
    const payload = '{"candidates":[{"content":{"parts":[{"text":"Jane said her card is 4111';
    const parsed = parseSseDataLine(`data: ${payload}`);
    expect(parsed).toEqual({ type: 'parse_error', errorName: 'SyntaxError', payloadChars: payload.length });
    expect(JSON.stringify(parsed)).not.toMatch(/Jane|4111|candidates/);
  });

  it('a whole event still yields its text', () => {
    expect(parseSseDataLine('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}')).toEqual({ type: 'text', text: 'hi' });
  });
});
