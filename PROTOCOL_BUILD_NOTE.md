# Protocol Build Note

## Background

`@smallseedlabs/proba-protocol` v0.1.0/v0.1.1 tags did not ship a built `dist/`,
so installing them from git failed TypeScript compilation ("Cannot find module").

## Resolution

proba-protocol PR #3 added a `prepare` script (`npm run build`), so npm builds the
package when installing it from a git URL. It is merged to `main` at
`c643d52f2515977251b4dec6e058b94cfb002e45` (package version 0.1.2).

proba-hub depends on the published v0.1.2 release tag, which points at that commit:

```json
"@smallseedlabs/proba-protocol": "github:smallseedlabs/proba-protocol#v0.1.2"
```
