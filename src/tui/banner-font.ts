// 三行方块字母标题。
//
// 终端无法改字号：单元格网格由终端自身字体固定，想让标题更大只能把它画在多个格子上。
// 每字母是 3x5 像素位图，半块字符把两行像素并进一行文本，五行像素于是变成三行文本。
// 字母拆成独立小块而不是三条长字符串，让闪烁能像小标题那样逐字着色。

// '#' 是点亮像素。每字五行；宽度各异，让标题尽量窄——这决定终端能否用大字标题。
const glyphs: Record<string, string[]> = {
    A: ['.#.', '#.#', '###', '#.#', '#.#'],
    C: ['###', '#..', '#..', '#..', '###'],
    I: ['#', '#', '#', '#', '#'],
    K: ['#.#', '#.#', '##.', '#.#', '#.#'],
    M: ['#.#', '###', '###', '#.#', '#.#'],
    O: ['###', '#.#', '#.#', '#.#', '###'],
    S: ['###', '#..', '###', '..#', '###'],
    T: ['###', '.#.', '.#.', '.#.', '.#.'],
    U: ['#.#', '#.#', '#.#', '#.#', '###'],
    // 按名字而不是按字符本身作键（'-' 不是合法标识符）；glyphFor 负责映射。
    Dash: ['..', '..', '##', '..', '..'],
};

function glyphFor(char: string): string[] {
    return (char === '-' ? glyphs.Dash : glyphs[char]) ?? glyphs.Dash ?? [];
}

// 半块字形是单格宽，一个像素列就是一个终端列。
function toCells(top: string, bottom: string): string {
    let out = '';
    for (let index = 0; index < top.length; index += 1) {
        const upper = top.charAt(index) === '#';
        const lower = bottom.charAt(index) === '#';
        out += upper && lower ? '█' : upper ? '▀' : lower ? '▄' : ' ';
    }
    return out;
}

export type TBigTitleLetter = { Char: string; Rows: string[] };

const TITLE_TEXT = 'Automatic-Task';

function buildLetters(): TBigTitleLetter[] {
    const upper = Array.from(TITLE_TEXT.toUpperCase());
    return upper.map((char, index) => {
        const glyph = glyphFor(char);
        const width = glyph[0]?.length ?? 0;
        const blank = ' '.repeat(width);
        // 除最后一个字母外，每个字母后留一列空隙，相邻字形不会黏在一起。
        const gap = index === upper.length - 1 ? '' : ' ';
        const rows = [0, 1, 2].map((row) => toCells(glyph[row * 2] ?? blank, glyph[row * 2 + 1] ?? blank) + gap);
        return { Char: char, Rows: rows };
    });
}

export const bigTitleLetters = buildLetters();

export const BIG_TITLE_ROWS = 3;

export const BIG_TITLE_WIDTH = bigTitleLetters.reduce((total, letter) => total + (letter.Rows[0]?.length ?? 0), 0);
