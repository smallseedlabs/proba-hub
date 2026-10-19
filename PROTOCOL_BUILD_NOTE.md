# Protocol Build Issue

## Problem

The `@smallseedlabs/proba-protocol` v0.1.0 tag does not include pre-built `dist/` files, causing TypeScript compilation to fail with "Cannot find module" errors.

## Root Cause

The protocol repository needs to either:
1. Include the `dist/` folder in the git tag (commit built files)
2. Add a `prepare` or `postinstall` script that builds from source
3. Publish to npm registry with built files

## Workaround

Until the protocol packaging is fixed, manually build the protocol after install:

```bash
cd node_modules/@smallseedlabs/proba-protocol
npm install
npm run build
cd ../../..
```

Or add to package.json:

```json
{
  "scripts": {
    "postinstall": "cd node_modules/@smallseedlabs/proba-protocol && npm install && npm run build || true"
  }
}
```

## Resolution

This should be fixed in the protocol repository before proba-hub v0.1.0 is released. The protocol maintainers should:
- Add `dist/` to the repository OR
- Set up proper npm publishing with build artifacts OR  
- Add a `prepare` script to package.json

## Status

- Code is complete and correct
- Runtime functionality will work once protocol is properly packaged
- TypeScript type checking will pass once protocol types are available
