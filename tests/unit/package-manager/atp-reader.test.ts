import { sanitizeZipEntryPath } from '@at/package-manager';
import { describe, expect, it } from 'vitest';

describe('zip path sanitization', () => {
    it('accepts normal paths', () => {
        expect(sanitizeZipEntryPath('scripts/fetch.bat')).toBe('scripts/fetch.bat');
        expect(sanitizeZipEntryPath('manifest.json')).toBe('manifest.json');
        expect(sanitizeZipEntryPath('assets/icon.png')).toBe('assets/icon.png');
    });

    it('normalizes backslashes', () => {
        expect(sanitizeZipEntryPath('scripts\\fetch.bat')).toBe('scripts/fetch.bat');
    });

    it('rejects parent traversal', () => {
        expect(sanitizeZipEntryPath('../malicious.exe')).toBeUndefined();
        expect(sanitizeZipEntryPath('a/../../evil.exe')).toBeUndefined();
        expect(sanitizeZipEntryPath('..\\..\\evil.exe')).toBeUndefined();
    });

    it('rejects absolute paths', () => {
        expect(sanitizeZipEntryPath('/etc/passwd')).toBeUndefined();
        expect(sanitizeZipEntryPath('C:\\Windows\\system32\\evil.exe')).toBeUndefined();
        expect(sanitizeZipEntryPath('\\\\server\\share\\evil.exe')).toBeUndefined();
    });

    it('rejects empty and dot-only paths', () => {
        expect(sanitizeZipEntryPath('')).toBeUndefined();
        expect(sanitizeZipEntryPath('.')).toBeUndefined();
    });

    it('strips redundant separators', () => {
        expect(sanitizeZipEntryPath('scripts//fetch.bat')).toBe('scripts/fetch.bat');
    });
});
