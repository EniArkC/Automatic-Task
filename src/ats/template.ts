import { AtParseError } from '@at/core';

import type { TTemplateNode, TTemplateSegment } from './ast';
import { variableNamePattern } from './tokens';

function parseTemplateSegments(raw: string, line: number, column: number, file: string): TTemplateSegment[] {
    const segments: TTemplateSegment[] = [];
    let textStart = 0;
    let index = 0;
    while (index < raw.length) {
        if (raw[index] === '$' && raw[index + 1] === '{') {
            const close = raw.indexOf('}', index + 2);
            if (close < 0) {
                throw new AtParseError({
                    File: file,
                    Line: line,
                    Column: column + index + 2,
                    Message: 'Unterminated variable expression in template',
                    Snippet: raw,
                    Suggestion: 'Close the expression with }',
                });
            }
            const name = raw.slice(index + 2, close);
            if (name === '') {
                throw new AtParseError({
                    File: file,
                    Line: line,
                    Column: column + index + 2,
                    Message: 'Empty variable reference in template',
                    Snippet: raw,
                });
            }
            if (!variableNamePattern.test(name)) {
                throw new AtParseError({
                    File: file,
                    Line: line,
                    Column: column + index + 2,
                    Message: `Invalid variable reference "${name}"`,
                    Snippet: raw,
                    Suggestion: 'Variable names use [a-zA-Z_][a-zA-Z0-9_]*',
                });
            }
            if (index > textStart) {
                segments.push({ Kind: 'text', Text: raw.slice(textStart, index) });
            }
            segments.push({ Kind: 'variable', Name: name });
            index = close + 1;
            textStart = index;
        } else {
            index++;
        }
    }
    if (textStart < raw.length) {
        segments.push({ Kind: 'text', Text: raw.slice(textStart) });
    }
    return segments;
}

export function parseTemplate(raw: string, line: number, column: number, file: string): TTemplateNode {
    return {
        Kind: 'template',
        Segments: parseTemplateSegments(raw, line, column, file),
        Raw: raw,
        Line: line,
        Column: column,
    };
}
