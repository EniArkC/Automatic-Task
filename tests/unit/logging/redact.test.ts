import { isSecretKey, redactSecrets } from '@at/logging';
import { describe, expect, it } from 'vitest';

describe('secret redaction', () => {
    it('recognizes secret key names case-insensitively', () => {
        for (const key of ['password', 'token', 'secret', 'apiKey', 'API_KEY', 'authorization', 'api-key']) {
            expect(isSecretKey(key)).toBe(true);
        }
        for (const key of ['city', 'depth', 'message', 'output']) {
            expect(isSecretKey(key)).toBe(false);
        }
    });

    it('masks secret values recursively', () => {
        const result = redactSecrets({
            token: 'abc123',
            city: '上海',
            nested: { password: 'p', ok: 'fine' },
            list: [{ secret: 's' }],
        });
        expect(result).toEqual({
            token: '****',
            city: '上海',
            nested: { password: '****', ok: 'fine' },
            list: [{ secret: '****' }],
        });
    });

    it('preserves non-object values', () => {
        expect(redactSecrets('plain')).toBe('plain');
        expect(redactSecrets(42)).toBe(42);
    });
});
