# Protocol Build Note

## Background

`@smallseedlabs/proba-protocol` v0.1.0/v0.1.1 tags did not ship a built `dist/`,
so installing them from git failed TypeScript compilation ("Cannot find module").

## Resolution

proba-protocol PR #3 added a `prepare` script (`npm run build`), so npm builds the
package when installing it from a git URL. It is merged to `main` at
`c643d52f2515977251b4dec6e058b94cfb002e45` (package version 0.1.2).

proba-hub depends on a published release tag. It moved from v0.1.2 to v0.2.0
(`5444c34`, additive: the `/audit` subpath with the AuditEvent contract and the
metrics schemas; the command/event/brain contract is unchanged):

```json
"@smallseedlabs/proba-protocol": "github:smallseedlabs/proba-protocol#v0.2.0"
```

It is now pinned to v0.3.1 (`5c20d28`: the audit action catalog `AUDIT_ACTION_INFO` with a
recommended category and default risk per action, the `control.*`, `stream.*`, `thread.*`, `goal.*`,
`budget.*` and `campaign.*` actions, and `generic` / `alias` markers on the v0.2.0 names). The Hub emits
only `specific` actions:

```json
"@smallseedlabs/proba-protocol": "github:smallseedlabs/proba-protocol#v0.3.1"
```
