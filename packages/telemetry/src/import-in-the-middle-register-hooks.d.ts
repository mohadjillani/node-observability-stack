// The package ships register-hooks.d.ts next to register-hooks.mjs without an
// exports map; TypeScript only pairs .mjs with .d.mts, so declare it here.
declare module 'import-in-the-middle/register-hooks.mjs' {
  export interface RegisterHooksOptions {
    include?: (string | RegExp)[];
    exclude?: (string | RegExp)[];
  }
  export function register(options?: RegisterHooksOptions): void;
  export function supportsSyncHooks(): boolean;
}
