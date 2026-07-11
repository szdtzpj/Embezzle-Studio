import { describe, expect, it } from 'vitest';

import { estimateTextTokens } from '../src/services/tokenEstimate';

describe('conservative local token estimation', () => {
  it('keeps a bounded ASCII word-run heuristic with safe separator floors', () => {
    expect(estimateTextTokens('test')).toBe(1);
    expect(estimateTextTokens('abcdefgh')).toBe(2);
    expect(estimateTextTokens('hello world')).toBe(5);
    expect(estimateTextTokens('...')).toBe(3);
    expect(estimateTextTokens(' \n\t')).toBe(3);
  });

  it.each([
    ['Arabic', 'مرحبا بالعالم'],
    ['Devanagari', 'नमस्ते दुनिया'],
    ['Thai', 'สวัสดีชาวโลก'],
    ['Hebrew', 'שלום עולם'],
    ['Cyrillic', 'Привет мир'],
  ])('counts every BMP non-ASCII code point with at least a one-token floor for %s', (_, text) => {
    const nonAsciiCodePoints = Array.from(text).filter(
      (character) => (character.codePointAt(0) ?? 0) > 0x7f
    ).length;
    expect(estimateTextTokens(text)).toBeGreaterThanOrEqual(nonAsciiCodePoints);
  });

  it('uses a conservative supplementary-plane floor for emoji', () => {
    expect(estimateTextTokens('😀')).toBe(4);
    expect(estimateTextTokens('😀'.repeat(25))).toBeGreaterThanOrEqual(100);
  });

  it('does not normalize full-width or compatibility characters into cheaper ASCII', () => {
    expect(estimateTextTokens('ＡＢＣＤ')).toBe(4);
    expect(estimateTextTokens('ﬃ')).toBe(1);
  });

  it('counts every newline instead of averaging whitespace toward zero', () => {
    expect(estimateTextTokens('\n'.repeat(100))).toBe(100);
    expect(estimateTextTokens(`x${'\n'.repeat(100)}`)).toBe(101);
  });
});
