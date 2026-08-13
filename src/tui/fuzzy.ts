// 命令面板和文件选择器输入的模糊子序列匹配。自行实现而非引入依赖：整个算法只是一趟贪心扫描，
// 而每个额外包都要随 esbuild 和 pkg 打包进成品可执行文件。
export type TFuzzyMatch = {
    Score: number;
    // 指向 Array.from(candidate) 的下标——码点而非 UTF-16 单元，CJK 文本的高亮才能与 theme.displayWidth 对齐。
    Positions: number[];
};

const boundaryChars = new Set([' ', '-', '_', '.', '/', '\\']);

function isBoundaryBefore(chars: string[], index: number): boolean {
    if (index === 0) {
        return true;
    }
    const previous = chars[index - 1] ?? '';
    return boundaryChars.has(previous);
}

function isCamelBoundary(chars: string[], index: number): boolean {
    if (index === 0) {
        return false;
    }
    const previous = chars[index - 1] ?? '';
    const current = chars[index] ?? '';
    return previous === previous.toLowerCase() && current !== current.toLowerCase();
}

// 贪心从左到右子序列匹配。贪心在一般情况下会出错（后面的命中可能得分更高），
// 但对命令标签和文件名，用户需要的是第一次命中，且能保持线性复杂度。
export function fuzzyMatch(pattern: string, candidate: string): TFuzzyMatch | undefined {
    if (pattern === '') {
        return { Score: 0, Positions: [] };
    }
    const needle = Array.from(pattern.toLowerCase());
    const chars = Array.from(candidate);
    const lower = chars.map((char) => char.toLowerCase());

    const positions: number[] = [];
    let score = 0;
    let cursor = 0;
    let previousMatch = -1;
    for (const want of needle) {
        let found = -1;
        for (let index = cursor; index < lower.length; index += 1) {
            if (lower[index] === want) {
                found = index;
                break;
            }
        }
        if (found < 0) {
            return undefined;
        }
        if (previousMatch >= 0 && found === previousMatch + 1) {
            score += 16;
        }
        if (found === 0) {
            score += 10;
        }
        if (isBoundaryBefore(chars, found)) {
            score += 8;
        }
        if (isCamelBoundary(chars, found)) {
            score += 4;
        }
        // 跳过的字符数和与上次命中的间隔都是轻微惩罚：让紧凑命中排在零散命中前面。
        score -= found - cursor;
        if (previousMatch >= 0) {
            score -= found - previousMatch - 1;
        }
        positions.push(found);
        previousMatch = found;
        cursor = found + 1;
    }
    return { Score: score, Positions: positions };
}

export type TFuzzyResult<TItem> = { Item: TItem; Match: TFuzzyMatch };

// 按得分排序，同分保持原顺序，用户输入时列表不会自行重排。
export function fuzzyRank<TItem>(
    pattern: string,
    items: readonly TItem[],
    textOf: (item: TItem) => string,
): TFuzzyResult<TItem>[] {
    const scored: { Result: TFuzzyResult<TItem>; Order: number }[] = [];
    items.forEach((item, order) => {
        const match = fuzzyMatch(pattern, textOf(item));
        if (match !== undefined) {
            scored.push({ Result: { Item: item, Match: match }, Order: order });
        }
    });
    scored.sort((left, right) =>
        left.Result.Match.Score === right.Result.Match.Score
            ? left.Order - right.Order
            : right.Result.Match.Score - left.Result.Match.Score,
    );
    return scored.map((entry) => entry.Result);
}
