import { describe, expect, it } from 'vitest';
import { canonicalRoomId, generateRoomCode, parseRoomInput, ROOM_CODE_ALPHABET } from '../src/roomcode.ts';

describe('room codes', () => {
  it('uses 24 unambiguous letters', () => {
    expect(ROOM_CODE_ALPHABET).toHaveLength(24);
    for (const bad of 'OI01') expect(ROOM_CODE_ALPHABET).not.toContain(bad);
  });

  it('makes 4-letter codes from the alphabet', () => {
    for (let i = 0; i < 500; i++) {
      const c = generateRoomCode(() => false, (n) => Math.floor(Math.random() * n));
      expect(c).toMatch(/^[A-HJ-NP-Z]{4}$/);
    }
  });

  it('never returns a taken code', () => {
    const taken = new Set(['AAAA', 'BBBB']);
    let i = 0;
    const seq = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2]; // AAAA, BBBB, CCCC
    expect(generateRoomCode((c) => taken.has(c), () => seq[i++])).toBe('CCCC');
  });

  it('falls back to 5 letters when 4-letter codes keep colliding', () => {
    const c = generateRoomCode((x) => x.length === 4, (n) => Math.floor(Math.random() * n));
    expect(c).toMatch(/^[A-HJ-NP-Z]{5}$/);
  });

  it('canonicalises codes (uppercase) and keeps legacy ids (lowercase)', () => {
    expect(canonicalRoomId('abcd')).toBe('ABCD');
    expect(canonicalRoomId(' Ab-Cd ')).toBe('ABCD');
    expect(canonicalRoomId('x7k2qz')).toBe('x7k2qz');
    expect(canonicalRoomId('X7K2QZ')).toBe('x7k2qz');
  });

  it('reads a code out of a pasted link or a bare code', () => {
    expect(parseRoomInput('https://ojb-cube.onrender.com/r/WXYZ')).toBe('WXYZ');
    expect(parseRoomInput('ojb-cube.onrender.com/r/wxyz?x=1')).toBe('WXYZ');
    expect(parseRoomInput('http://localhost:3001/r/ab12cd')).toBe('ab12cd');
    expect(parseRoomInput('  qrst ')).toBe('QRST');
    expect(parseRoomInput('')).toBe('');
  });
});
