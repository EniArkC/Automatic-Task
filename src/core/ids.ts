import { randomBytes } from 'node:crypto';

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const TOTAL_LENGTH = TIME_LENGTH + RANDOM_LENGTH;

function encodeBase32(value: bigint, length: number): string {
    let encoded = '';
    let remaining = value;
    for (let i = 0; i < length; i++) {
        const digit = Number(remaining & 31n);
        encoded = CROCKFORD_ALPHABET[digit] + encoded;
        remaining >>= 5n;
    }
    return encoded;
}

function decodeBase32(value: string): bigint {
    let decoded = 0n;
    for (const char of value) {
        const index = CROCKFORD_ALPHABET.indexOf(char);
        if (index < 0) {
            return -1n;
        }
        decoded = (decoded << 5n) | BigInt(index);
    }
    return decoded;
}

export function isValidUlid(value: string): boolean {
    if (value.length !== TOTAL_LENGTH) {
        return false;
    }
    const timePart = decodeBase32(value.slice(0, TIME_LENGTH));
    if (timePart < 0n) {
        return false;
    }
    // 10 字符编码要求 48 位时间戳的最高 2 位必须为 0。
    return timePart < 1n << 48n && decodeBase32(value.slice(TIME_LENGTH)) >= 0n;
}

export function ulidToTimestamp(ulid: string): number {
    return Number(decodeBase32(ulid.slice(0, TIME_LENGTH)));
}

export function ulidToDate(ulid: string): Date {
    return new Date(ulidToTimestamp(ulid));
}

export interface IIdGenerator {
    Next(): string;
}

let lastTimestamp = 0;
let lastRandomPart = 0n;

// ULID 唯一且按时间有序，运行 ID 因此在日志目录中自然排序。
export class UlidGenerator implements IIdGenerator {
    public Next(): string {
        const timestamp = Date.now();
        let randomPart = this.NextRandomPart();
        if (timestamp === lastTimestamp) {
            lastRandomPart += 1n;
            randomPart = lastRandomPart;
        } else {
            lastTimestamp = timestamp;
            lastRandomPart = randomPart;
        }
        return encodeBase32(BigInt(timestamp), TIME_LENGTH) + encodeBase32(randomPart, RANDOM_LENGTH);
    }

    private NextRandomPart(): bigint {
        return BigInt('0x' + randomBytes(RANDOM_LENGTH).toString('hex'));
    }
}
