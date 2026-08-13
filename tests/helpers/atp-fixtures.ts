import { createWriteStream } from 'node:fs';
import { crc32 } from 'node:zlib';

import yazl from 'yazl';

export type TAtpFixtureEntry = { name: string; content: string };

export function buildAtp(file: string, entries: TAtpFixtureEntry[]): Promise<void> {
    const zip = new yazl.ZipFile();
    for (const entry of entries) {
        zip.addBuffer(Buffer.from(entry.content, 'utf8'), entry.name);
    }
    zip.end();
    return new Promise<void>((resolve, reject) => {
        zip.outputStream.pipe(createWriteStream(file)).on('close', resolve).on('error', reject);
    });
}

// yazl refuses to write `..` names, so zip-slip fixtures need raw zip bytes.
export function buildRawZipBytes(entries: TAtpFixtureEntry[]): Buffer {
    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        const nameBuffer = Buffer.from(entry.name, 'utf8');
        const contentBuffer = Buffer.from(entry.content, 'utf8');
        const checksum = crc32(contentBuffer);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(contentBuffer.length, 18);
        local.writeUInt32LE(contentBuffer.length, 22);
        local.writeUInt16LE(nameBuffer.length, 26);
        local.writeUInt16LE(0, 28);
        localParts.push(local, nameBuffer, contentBuffer);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0, 14);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(contentBuffer.length, 20);
        central.writeUInt32LE(contentBuffer.length, 24);
        central.writeUInt16LE(nameBuffer.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        centralParts.push(central, nameBuffer);
        offset += local.length + nameBuffer.length + contentBuffer.length;
    }
    const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
    const endOfCentral = Buffer.alloc(22);
    endOfCentral.writeUInt32LE(0x06054b50, 0);
    endOfCentral.writeUInt16LE(0, 4);
    endOfCentral.writeUInt16LE(0, 6);
    endOfCentral.writeUInt16LE(entries.length, 8);
    endOfCentral.writeUInt16LE(entries.length, 10);
    endOfCentral.writeUInt32LE(centralSize, 12);
    endOfCentral.writeUInt32LE(offset, 16);
    endOfCentral.writeUInt16LE(0, 20);
    return Buffer.concat([...localParts, ...centralParts, endOfCentral]);
}

export function manifestEntry(overrides: Record<string, unknown> = {}): TAtpFixtureEntry {
    const manifest = {
        spec: 'atp/v1',
        id: 'daily-report',
        name: 'Daily Report',
        version: '1.0.0',
        description: 'Generate daily report',
        author: 'Example',
        ...overrides,
    };
    return { name: 'manifest.json', content: JSON.stringify(manifest) };
}

export function taskAtsEntry(source = '[Start]\n-> [Script(`echo hi`)]\n[End]\n'): TAtpFixtureEntry {
    return { name: 'task.ats', content: source };
}

export function basicAtpEntries(): TAtpFixtureEntry[] {
    return [
        manifestEntry(),
        taskAtsEntry(),
        { name: 'scripts/fetch.bat', content: '@echo off\r\necho fetch\r\n' },
        { name: 'README.md', content: '# readme' },
    ];
}
