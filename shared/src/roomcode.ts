/**
 * Room codes: short, easy to read aloud and type on a phone. New rooms get 4 uppercase letters from an alphabet without the
 * look-alikes O/0 and I/1 (24^4 = 331,776 codes). Older rooms have 6-character lowercase ids; those still work everywhere.
 */

/** Letters used in room codes: A–Z without I and O (and, being letters only, no 0 or 1). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 4;

/**
 * The canonical form of a room id as typed or found in a URL: short letter codes are uppercase, legacy ids lowercase.
 * Strips anything that isn't a letter or digit. Returns '' for empty input.
 */
export function canonicalRoomId(raw: string): string {
  const s = String(raw ?? '').replace(/[^A-Za-z0-9]/g, '');
  return /^[A-Za-z]{4,5}$/.test(s) ? s.toUpperCase() : s.toLowerCase();
}

/** The room id in whatever a person pasted: a full invite link (…/r/ABCD), a path, or a bare code. '' when there is none. */
export function parseRoomInput(text: string): string {
  const t = String(text ?? '').trim();
  const m = /\/r\/([A-Za-z0-9]+)/.exec(t);
  return canonicalRoomId(m ? m[1] : t);
}

/**
 * A new room code that `taken` doesn't already use. `randomInt(n)` returns an integer in [0, n). After many collisions (a nearly
 * full code space) it falls back to 5 letters.
 */
export function generateRoomCode(taken: (code: string) => boolean, randomInt: (n: number) => number): string {
  for (let attempt = 0; attempt < 200; attempt++) {
    const len = attempt < 100 ? ROOM_CODE_LENGTH : ROOM_CODE_LENGTH + 1;
    let code = '';
    for (let i = 0; i < len; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    if (!taken(code)) return code;
  }
  throw new Error('No free room code');
}
