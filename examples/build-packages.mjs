import { createWriteStream, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';

const examplesRoot = join(dirname(fileURLToPath(import.meta.url)), 'task-packages');

function collectFiles(dir) {
    const files = [];
    const visit = (current) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const full = join(current, entry.name);
            if (entry.isDirectory()) {
                visit(full);
            } else {
                files.push(full);
            }
        }
    };
    visit(dir);
    return files;
}

async function zipPackage(sourceDir, outFile) {
    const zip = new yazl.ZipFile();
    for (const file of collectFiles(sourceDir)) {
        const name = relative(sourceDir, file).replace(/\\/g, '/');
        zip.addBuffer(readFileSync(file), name);
    }
    zip.end();
    await new Promise((resolve, reject) => {
        zip.outputStream.pipe(createWriteStream(outFile)).on('close', resolve).on('error', reject);
    });
    const size = statSync(outFile).size;
    console.log(`built ${outFile} (${size} bytes)`);
}

for (const entry of readdirSync(examplesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
        continue;
    }
    const sourceDir = join(examplesRoot, entry.name);
    const outFile = join(examplesRoot, `${entry.name}.atp`);
    await zipPackage(sourceDir, outFile);
}
console.log('All example packages built.');
