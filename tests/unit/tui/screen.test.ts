import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
    enterFullScreen,
    installResizeClear,
    installSynchronizedOutput,
    leaveFullScreen,
} from '../../../src/tui/screen';

// Resizing narrower used to leave the bottom of the previous, wider frame on
// screen: ink erases exactly as many lines as the last frame had, but the
// console host has already reflowed those lines into more physical rows, so the
// erase falls short. The remedy is to wipe the buffer before ink's own resize
// listener repaints -- these tests pin the properties that make that safe.
const CLEAR_SCREEN = '\u001B[2J\u001B[H';

type TFake = NodeJS.WriteStream & { columns: number; rows: number };

function fakeStream(columns: number, rows: number): { Stream: TFake; Writes: string[] } {
    const writes: string[] = [];
    const stream = new PassThrough();
    Object.assign(stream, { columns, rows, isTTY: true });
    stream.write = (chunk: unknown): boolean => {
        writes.push(String(chunk));
        return true;
    };
    return { Stream: stream as unknown as TFake, Writes: writes };
}

describe('resize clear', () => {
    it('clears the buffer when the size actually changes', () => {
        const { Stream: stream, Writes: writes } = fakeStream(100, 30);
        enterFullScreen(stream);
        const dispose = installResizeClear(stream);
        try {
            writes.length = 0;
            stream.columns = 60;
            stream.emit('resize');
            expect(writes).toEqual([CLEAR_SCREEN]);
        } finally {
            dispose();
            leaveFullScreen(stream);
        }
    });

    it('ignores a resize event that reports the size it already had', () => {
        // Dragging a window edge emits a burst of these. ink writes nothing when
        // the frame is unchanged, so clearing on one would blank the screen.
        const { Stream: stream, Writes: writes } = fakeStream(100, 30);
        enterFullScreen(stream);
        const dispose = installResizeClear(stream);
        try {
            writes.length = 0;
            stream.emit('resize');
            stream.emit('resize');
            expect(writes).toEqual([]);
        } finally {
            dispose();
            leaveFullScreen(stream);
        }
    });

    it('stops clearing once disposed', () => {
        const { Stream: stream, Writes: writes } = fakeStream(100, 30);
        enterFullScreen(stream);
        installResizeClear(stream)();
        try {
            writes.length = 0;
            stream.rows = 20;
            stream.emit('resize');
            expect(writes).toEqual([]);
        } finally {
            leaveFullScreen(stream);
        }
    });

    it('writes nothing outside the alternate buffer', () => {
        // The guards leave the buffer on the way out; a late resize event must
        // not scribble a clear over the user's real console.
        const { Stream: stream, Writes: writes } = fakeStream(100, 30);
        const dispose = installResizeClear(stream);
        try {
            writes.length = 0;
            stream.columns = 60;
            stream.emit('resize');
            expect(writes).toEqual([]);
        } finally {
            dispose();
        }
    });
});

// ink 每帧写的是 eraseLines(上一帧行数) + 整帧文本：擦除自下而上、重画自上而下。终端可以在
// 这两步之间刷新一次，那一瞬间下半屏已被擦掉却还没重写——就是用户看到的下半部分闪烁。
// 把成帧的写入包进 DEC 2026 后，终端把整帧当一次原子更新。
const BEGIN_SYNC = '\u001B[?2026h';
const END_SYNC = '\u001B[?2026l';

describe('synchronized output', () => {
    it('brackets a frame repaint', () => {
        const { Stream: stream, Writes: writes } = fakeStream(100, 30);
        const dispose = installSynchronizedOutput(stream);
        try {
            const frame = '\u001B[2K\u001B[1A\u001B[2K\u001B[Ghello\n';
            stream.write(frame);
            expect(writes).toEqual([BEGIN_SYNC + frame + END_SYNC]);
        } finally {
            dispose();
        }
    });

    it('brackets a full-screen clear', () => {
        // ink falls back to clearTerminal when a frame is as tall as the
        // terminal; that write is the one most worth making atomic.
        const { Stream: stream, Writes: writes } = fakeStream(100, 30);
        const dispose = installSynchronizedOutput(stream);
        try {
            stream.write(CLEAR_SCREEN);
            expect(writes).toEqual([BEGIN_SYNC + CLEAR_SCREEN + END_SYNC]);
        } finally {
            dispose();
        }
    });

    it('leaves writes that carry no frame alone', () => {
        // Cursor show/hide and the alt-screen switch carry no frame content;
        // wrapping them would only open a pointless synchronization window.
        const { Stream: stream, Writes: writes } = fakeStream(100, 30);
        const dispose = installSynchronizedOutput(stream);
        try {
            stream.write('\u001B[?25l');
            stream.write('\u001B[?1049h');
            expect(writes).toEqual(['\u001B[?25l', '\u001B[?1049h']);
        } finally {
            dispose();
        }
    });

    it('restores the original write on dispose', () => {
        const { Stream: stream, Writes: writes } = fakeStream(100, 30);
        installSynchronizedOutput(stream)();
        stream.write(CLEAR_SCREEN);
        expect(writes).toEqual([CLEAR_SCREEN]);
    });
});
