const semverPattern =
    /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+(?<build>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isValidSemver(value: string): boolean {
    return semverPattern.test(value);
}

type TSemverParts = {
    Major: number;
    Minor: number;
    Patch: number;
    Prerelease?: string;
};

function parseSemver(value: string): TSemverParts | undefined {
    const groups = semverPattern.exec(value)?.groups;
    if (groups === undefined) {
        return undefined;
    }
    return {
        Major: Number(groups.major ?? 0),
        Minor: Number(groups.minor ?? 0),
        Patch: Number(groups.patch ?? 0),
        Prerelease: groups.prerelease,
    };
}

function compareIdentifiers(left: string, right: string): number {
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
        return Number(left) - Number(right);
    }
    if (leftNumeric) {
        return -1;
    }
    if (rightNumeric) {
        return 1;
    }
    return left < right ? -1 : left > right ? 1 : 0;
}

function comparePrerelease(left: string | undefined, right: string | undefined): number {
    // 不带预发布后缀的版本大于带后缀的版本。
    if (left === undefined && right === undefined) {
        return 0;
    }
    if (left === undefined) {
        return 1;
    }
    if (right === undefined) {
        return -1;
    }
    const leftParts = left.split('.');
    const rightParts = right.split('.');
    const length = Math.max(leftParts.length, rightParts.length);
    for (let i = 0; i < length; i++) {
        const leftPart = leftParts[i] ?? '';
        const rightPart = rightParts[i] ?? '';
        if (leftPart === rightPart) {
            continue;
        }
        if (leftPart === '') {
            return -1;
        }
        if (rightPart === '') {
            return 1;
        }
        return compareIdentifiers(leftPart, rightPart);
    }
    return 0;
}

export function compareSemver(left: string, right: string): number {
    const leftParts = parseSemver(left);
    const rightParts = parseSemver(right);
    if (leftParts === undefined || rightParts === undefined) {
        throw new TypeError(`Invalid semver: "${left}" or "${right}"`);
    }
    if (leftParts.Major !== rightParts.Major) {
        return leftParts.Major > rightParts.Major ? 1 : -1;
    }
    if (leftParts.Minor !== rightParts.Minor) {
        return leftParts.Minor > rightParts.Minor ? 1 : -1;
    }
    if (leftParts.Patch !== rightParts.Patch) {
        return leftParts.Patch > rightParts.Patch ? 1 : -1;
    }
    return comparePrerelease(leftParts.Prerelease, rightParts.Prerelease);
}
