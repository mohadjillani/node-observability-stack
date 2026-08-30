# ADR 0006: ESM auto-instrumentation through the synchronous loader hook

**Status:** accepted · **Date:** 2026-08-30

## Context

The services are ES modules. OpenTelemetry's instrumentations patch
libraries as they are loaded; for CommonJS that is a `require` hook, and
for ESM it needs a loader hook (`import-in-the-middle`) registered
before the application imports anything. Node offers two ways to
register one:

- `module.register()` runs the hook on a **separate loader thread**,
  with a message channel so the instrumentations can tell it which
  modules to wrap and the main thread waits for acknowledgement. This is
  what the OpenTelemetry documentation shows.
- `module.registerHooks()` (Node 22.15+, usable for this purpose from
  22.22.3 / 24.11.1) runs the hook **synchronously on the application
  thread**: no second thread, no message channel, no handshake.

Building the cross-process test exposed the difference: with the
off-thread loader on Node 23, the worker stalled on roughly every other
start, before its main module ran, inside the loader while wrapping the
import graph. It was not an application bug; it was a deadlock between
the two threads that a trivial program never hit and the api rarely did.

## Decision

`packages/telemetry/src/register.ts` uses the synchronous hook when
`supportsSyncHooks()` says the running Node can, and falls back to the
off-thread loader with the message channel otherwise. In both cases the
hook is registered first, the SDK second, and only the modules the
instrumentations actually patch are wrapped — the list is derived from
the instrumentations' module definitions, so unrelated modules (zod, for
one, which the wrapper failed on) are left alone and startup is faster.

`engines.node` is `>=22`, the images use `node:22-alpine` and CI runs 22
and 24, so the synchronous path is the one that runs everywhere the
repository controls. The fallback exists for older 22.x; it works, and
the stall has not been observed on Node 22, but it is the path that
cannot be fully trusted.

Operationally the hook is `node --import @mohadjillani/telemetry/register app.js`
— the same line in the Dockerfile, the npm scripts and the integration
test, so what is tested is what runs.

## Consequences

- No CommonJS build of the services just to make instrumentation easy.
- The register entry is one file and the behaviour is testable: the
  cross-process test runs both services this way, and the SDK-disabled
  path (`OTEL_SDK_DISABLED=true`) skips the hook entirely for the
  overhead baseline.
- Node 20 is not supported. It would use the off-thread loader, and the
  observed stall is reason enough not to claim it.
- `import-in-the-middle`'s `register-hooks.mjs` ships without an
  `exports` map or a `.d.mts`, so the package carries a small ambient
  declaration for it.
- The trigger for revisiting: OpenTelemetry's own `register` entry
  adopting the synchronous hook, at which point this file shrinks to
  configuration.
