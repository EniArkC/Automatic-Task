import { AtPackageError, isValidPackageId, isValidSemver, type TErrorOptions } from '@at/core';

export const ATP_SPEC = 'atp/v1';

// 这些键绝不能出现在包清单中；它们属于用户的任务配置，出现会破坏包的不可变性。
export const forbiddenManifestKeys = ['schedule', 'enabled', 'cron', 'variables', 'userConfig'] as const;
export type TManifest = {
    spec: string;
    id: string;
    name: string;
    version: string;
    description?: string;
    author?: string;
};

function fail(message: string, options?: TErrorOptions): never {
    throw new AtPackageError(message, options);
}

export function validateManifest(value: unknown): string[] {
    const errors: string[] = [];
    if (typeof value !== 'object') {
        return ['manifest must be a JSON object'];
    }
    const raw = value as Record<string, unknown>;
    if (raw.spec !== ATP_SPEC) {
        errors.push(`spec must be "${ATP_SPEC}"`);
    }
    if (typeof raw.id !== 'string' || !isValidPackageId(raw.id)) {
        errors.push('id must match ^[a-z0-9-]{3,64}$');
    }
    if (typeof raw.name !== 'string' || raw.name.trim() === '') {
        errors.push('name must be a non-empty string');
    }
    if (typeof raw.version !== 'string' || !isValidSemver(raw.version)) {
        errors.push('version must be a valid semver');
    }
    if (raw.description !== undefined && typeof raw.description !== 'string') {
        errors.push('description must be a string');
    }
    if (raw.author !== undefined && typeof raw.author !== 'string') {
        errors.push('author must be a string');
    }
    for (const key of forbiddenManifestKeys) {
        if (key in raw) {
            errors.push(`forbidden key "${key}" is not allowed in a package manifest`);
        }
    }
    return errors;
}

export function parseManifest(json: string): TManifest {
    let value: unknown;
    try {
        value = JSON.parse(json);
    } catch (error) {
        fail(`manifest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const errors = validateManifest(value);
    if (errors.length > 0) {
        fail(`Invalid manifest.json: ${errors.join('; ')}`);
    }
    const raw = value as Record<string, unknown>;
    const manifest: TManifest = {
        spec: raw.spec as string,
        id: raw.id as string,
        name: raw.name as string,
        version: raw.version as string,
    };
    if (typeof raw.description === 'string') {
        manifest.description = raw.description;
    }
    if (typeof raw.author === 'string') {
        manifest.author = raw.author;
    }
    return manifest;
}
