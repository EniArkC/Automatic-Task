import { AtParseError, AtUserError, EErrorKind, isValidPackageId } from '@at/core';
import { describe, expect, it } from 'vitest';

describe('errors', () => {
    it('carries kind and exit code', () => {
        const error = new AtUserError('boom');
        expect(error.Kind).toBe(EErrorKind.User);
        expect(error.ExitCode).toBe(1);
        expect(error.name).toBe('AtUserError');
        expect(error.message).toBe('boom');
    });

    it('formats parse errors with position and caret', () => {
        const error = new AtParseError({
            File: 'task.ats',
            Line: 12,
            Column: 18,
            Message: "Unexpected token ')'",
            Snippet: '-> [Agent(`hello`, timeout: )]',
            Suggestion: 'Expected number.',
        });
        expect(error.message).toContain('task.ats:12:18');
        expect(error.message).toContain("Unexpected token ')'");
        expect(error.message).toContain('^');
        expect(error.message).toContain('Expected number.');
        expect(error.Detail.Column).toBe(18);
    });
});

describe('package id', () => {
    it('accepts valid ids', () => {
        expect(isValidPackageId('daily-report')).toBe(true);
        expect(isValidPackageId('abc')).toBe(true);
        expect(isValidPackageId('a-1-b')).toBe(true);
    });

    it('rejects invalid ids', () => {
        expect(isValidPackageId('Daily Report')).toBe(false);
        expect(isValidPackageId('daily_report')).toBe(false);
        expect(isValidPackageId('中文任务')).toBe(false);
        expect(isValidPackageId('../foo')).toBe(false);
        expect(isValidPackageId('ab')).toBe(false);
        expect(isValidPackageId('a'.repeat(65))).toBe(false);
        expect(isValidPackageId('')).toBe(false);
    });
});
