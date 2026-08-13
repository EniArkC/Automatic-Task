import { afterEach, describe, expect, it } from 'vitest';

import { resolveRuntimeEntry } from '../../../src/cli/runtime-launcher';

// The packaged CLI starts the daemon by relaunching its own executable. pkg
// patches child_process.spawn and stamps PKG_EXECPATH with that same path
// whenever the variable is absent; the child then believes it was invoked as a
// plain node, drops argv[1] and tries to load --runtime-daemon as a script,
// so the daemon dies before it can listen. pkg only fills the variable in when
// it is missing, so the spawn must carry an explicit value. This regression
// broke `autotask status` on a clean machine while every dev path stayed green.

const originalEnv = { ...process.env };

function withPkg(run: () => void): void {
    Object.defineProperty(process, 'pkg', { value: {}, configurable: true, enumerable: true });
    try {
        run();
    } finally {
        Reflect.deleteProperty(process, 'pkg');
    }
}

afterEach(() => {
    process.env = { ...originalEnv };
});

describe('resolveRuntimeEntry', () => {
    it('prefers an explicit runtime entry override', () => {
        process.env.AT_RUNTIME_ENTRY = 'C:\\custom\\runtime.exe';
        const target = resolveRuntimeEntry();
        expect(target.Command).toBe('C:\\custom\\runtime.exe');
        expect(target.Args).toEqual([]);
    });

    it('relaunches its own executable with the daemon switch when packaged', () => {
        delete process.env.AT_RUNTIME_ENTRY;
        withPkg(() => {
            const target = resolveRuntimeEntry();
            expect(target.Command).toBe(process.execPath);
            expect(target.Args).toEqual(['--runtime-daemon']);
        });
    });

    it('pins PKG_EXECPATH so the child keeps its own entrypoint', () => {
        delete process.env.AT_RUNTIME_ENTRY;
        withPkg(() => {
            const env = resolveRuntimeEntry().Env;
            expect(env).toBeDefined();
            // Any value other than the executable path works; what matters is
            // that pkg finds the variable already set and leaves it alone.
            expect(env?.PKG_EXECPATH).toBeDefined();
            expect(env?.PKG_EXECPATH).not.toBe(process.execPath);
        });
    });

    it('leaves the environment untouched outside the packaged form', () => {
        delete process.env.AT_RUNTIME_ENTRY;
        const target = resolveRuntimeEntry();
        // Only the packaged form needs the PKG_EXECPATH pin; the dev and
        // bundle paths inherit the parent environment as they always have.
        expect(target.Env).toBeUndefined();
        expect(target.Command).toBe(process.execPath);
    });
});
