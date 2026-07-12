const ASCII_WORD_CHARACTER = /^[A-Za-z0-9]$/;
const ASCII_CHARACTERS_PER_ESTIMATED_TOKEN = 4;
const SUPPLEMENTARY_CODE_POINT_TOKEN_FLOOR = 4;

/**
 * Conservative local text estimate. This is not provider billing data.
 *
 * ASCII letters and digits retain the familiar four-characters-per-token
 * heuristic, but each separate run costs at least one token. Whitespace,
 * punctuation, controls, and every BMP non-ASCII code point cost at least one
 * token. Supplementary-plane characters (including most emoji) use a four
 * token floor because provider tokenizers often split their UTF-8 bytes.
 *
 * Deliberately do not normalize before counting: compatibility normalization
 * can turn a non-ASCII code point into cheap ASCII and make a hard context gate
 * underestimate the original provider payload.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let estimate = 0;
  let asciiWordRunLength = 0;
  const flushAsciiWordRun = () => {
    if (asciiWordRunLength === 0) return;
    estimate += Math.max(
      1,
      Math.ceil(asciiWordRunLength / ASCII_CHARACTERS_PER_ESTIMATED_TOKEN)
    );
    asciiWordRunLength = 0;
  };

  for (const character of text) {
    if (ASCII_WORD_CHARACTER.test(character)) {
      asciiWordRunLength += 1;
      continue;
    }
    flushAsciiWordRun();
    const codePoint = character.codePointAt(0) ?? 0;
    estimate += codePoint > 0xffff ? SUPPLEMENTARY_CODE_POINT_TOKEN_FLOOR : 1;
  }
  flushAsciiWordRun();
  return Math.max(1, estimate);
}
