/** Counts Unicode code points, matching user-visible character limits in domain services. */
export function unicodeCharacterLength(value: string): number {
  let length = 0;
  for (const character of value) {
    length += character.length > 0 ? 1 : 0;
  }
  return length;
}

export function unicodeCharacterLengthExceeds(value: string, maximum: number): boolean {
  let length = 0;
  for (const character of value) {
    length += character.length > 0 ? 1 : 0;
    if (length > maximum) return true;
  }
  return false;
}

export function sliceUnicodeCharacters(value: string, maximum: number): string {
  if (maximum <= 0) return '';
  if (value.length <= maximum) return value;
  let result = '';
  let length = 0;
  for (const character of value) {
    if (length >= maximum) break;
    result += character;
    length += 1;
  }
  return result;
}
