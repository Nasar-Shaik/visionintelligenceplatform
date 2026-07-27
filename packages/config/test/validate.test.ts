import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseEnv } from '../src/validate.js';

describe('parseEnv', () => {
  const schema = z.object({
    A: z.string().min(1),
    B: z.coerce.number(),
  });

  it('returns parsed data when valid', () => {
    expect(parseEnv(schema, { A: 'x', B: '3' }, 'test')).toEqual({ A: 'x', B: 3 });
  });

  it('throws ConfigError naming the group and all issues', () => {
    try {
      parseEnv(schema, { B: 'not-a-number' }, 'test');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as ConfigError).message;
      expect(message).toContain('Invalid "test" configuration');
      expect(message).toContain('A:');
      expect(message).toContain('B:');
    }
  });
});
