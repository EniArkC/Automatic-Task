const packageIdPattern = /^[a-z0-9-]{3,64}$/;

export function isValidPackageId(value: string): boolean {
    return packageIdPattern.test(value);
}
