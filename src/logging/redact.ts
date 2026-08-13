import { isNull } from '@at/core';

// 这些键名的值绝不能以明文进入日志。键名去掉非字母数字并小写后匹配，
// 因此 `apiKey`、`API_KEY`、`api-key` 都会被覆盖。
const secretKeyPattern =
    /^(?<name>password|passwd|token|secret|apikey|accesstoken|refreshtoken|authorization|auth|clientsecret|authtoken|accesskey|secretkey|secretaccesskey|clientkey|privatekey)$/;

export function isSecretKey(key: string): boolean {
    return secretKeyPattern.test(key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase());
}

export function maskSecret(): string {
    return '****';
}

// 递归掩盖键名疑似密钥的值，变量快照和元数据不会把 token 泄漏到文件或事件中。
export function redactSecrets(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => redactSecrets(item));
    }
    if (typeof value !== 'object') {
        return value;
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (isNull(item)) {
            result[key] = item;
        } else if (isSecretKey(key)) {
            result[key] = maskSecret();
        } else {
            result[key] = redactSecrets(item);
        }
    }
    return result;
}
