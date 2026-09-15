# Where these tarballs came from

Both were built from **`fdeda564ecd7eacbf2ce900fe6a24719fac065fe`** of
<https://github.com/x402-foundation/x402> (2026-09-09, *"feat(mcp,ts): use accept's
maxTimeoutSeconds for tool timeout + Cardano sdk followups"*, PR #3430).

| tarball | package | upstream path | sha256 |
| --- | --- | --- | --- |
| `x402-cardano-2.25.0.tgz` | `@x402/cardano` | `typescript/packages/mechanisms/cardano` | `94a8e0cc3396cfba976f3d669fc585f031e75db55fe2847e4e24d91a134fb330` |
| `x402-core-2.25.0.tgz` | `@x402/core` | `typescript/packages/core` | `3973b9d8ca81f99aa018dc72995f4d015312ef041cea0ba7e0cf64eca7825f45` |

`vendor/checksums.txt` is the machine-readable copy and is checked on every `npm test`.

## The version number does not mean what it looks like

**`@x402/cardano@2.25.0` is not a release.** Upstream tagged `npm-@x402/<pkg>@v2.25.0` for twenty-one
packages — aptos, avm, axios, concordium, core, evm, express, extensions, fastify, fetch, hedera,
hono, keeta, mcp, near, next, paywall, stellar, svm, tvm, xrpl — and **not** for cardano. All those
tags dereference to `2cc7e9a6880c08433b692666032862bcbea51187` (2026-09-04), and at that commit
`typescript/packages/mechanisms/cardano` **does not exist**: Cardano was merged five days later, in
`42ee42b` (PR #2537), and has carried the in-development version `2.25.0` ever since without being
published.

The consequence worth internalising: **the vendored `@x402/core` is also not the published
`@x402/core@2.25.0`.** Downloading that version from npm and diffing it against
`vendor/x402-core-2.25.0.tgz` gives 25 differing files and four chunks whose content-hashed names do
not even match — because the vendored copy was built from the same post-release tree as cardano. So
"2.25.0" identifies neither artifact. The commit does; the version does not; use the commit.

## Verifying it yourself

```
npm run verify:vendor                                   # sha256 only, offline
npm run verify:vendor -- --provenance /path/to/x402     # and against the upstream source
```

The provenance pass does not rebuild anything. Both bundles ship `sourcesContent` inside their
`.map` files, so the original TypeScript is recoverable from the artifact and can be compared
against the checkout directly — a stronger statement than a checksum, since it says what the code
*is* rather than only that it has not changed since someone looked. As verified on 2026-09-15:

```
ok    commit fdeda564ecd7eacbf2ce900fe6a24719fac065fe
ok    x402-cardano-2.25.0.tgz: 28/28 recovered sources identical to typescript/packages/mechanisms/cardano
ok    x402-core-2.25.0.tgz: 15/15 recovered sources identical to typescript/packages/core
```

To get the commit into a checkout without cloning the whole monorepo:

```
git init x402 && cd x402
git remote add origin https://github.com/x402-foundation/x402
git fetch --depth 1 --filter=blob:none origin fdeda564ecd7eacbf2ce900fe6a24719fac065fe
```

Files the bundles do not account for — `src/index.ts`, `src/types.ts` and the other barrels — are
absent by construction: re-export barrels get flattened into their consumers and type-only modules
are erased, so neither survives into a source map. Their content still reaches the build through the
files that do appear.

## What this does and does not buy you

It buys: the bytes cannot be swapped without `npm test` failing, and the code they contain is
demonstrably the upstream code at a named commit rather than something someone typed.

It does not buy: any claim that the code is correct, that the commit was reviewed, or that upstream's
`main` is trustworthy. Provenance is not review. What is being pinned here is unpublished code that
signs real transactions; before mainnet, someone should read it, or wait for a published release
with npm provenance attestations behind it.
