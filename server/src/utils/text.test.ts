import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { cleanText } from './text.js';

describe('cleanText', () => {
  it('never returns control characters, edge spaces or more than the limit', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), fc.integer({ min: 1, max: 300 }), (s, max) => {
        const out = cleanText(s, max);
        expect(out.length).toBeLessThanOrEqual(max);
        expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
        expect(out).toBe(out.trim());
        expect(out).not.toMatch(/\s{2}/);
      }),
    );
  });
});
