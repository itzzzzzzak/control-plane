# Security Policy

control-plane handles OAuth tokens and API credentials, and it is driven by AI models that can make mistakes or be manipulated. We take security reports seriously and want to make them easy to send.

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.**

Report it privately with GitHub's vulnerability reporting:

**[Report a vulnerability](https://github.com/itzzzzzzak/control-plane/security/advisories/new)** (or the repository's **Security** tab → **Report a vulnerability**).

Please include as much of this as you can:

- a description of the issue and its impact (what an attacker gains);
- steps to reproduce, ideally with a minimal proof of concept;
- the affected component (for example `src/oauth.ts`, a named connector, or `control-plane-mcp`) and version;
- whether any real credentials or data were exposed.

Do not include live secrets in the report; redact tokens.

## What to expect

- **Acknowledgement** within 3 business days.
- **An initial assessment** (confirmed, needs more information, or not a vulnerability) within 10 business days.
- **A fix and advisory.** We develop the fix privately, release a patch, then publish a GitHub Security Advisory that names the fixed release and how to upgrade. Because control-plane is distributed from GitHub Releases rather than a package registry, the advisory is how users find out; watch the repository's releases and advisories.
- **Credit** in the advisory if you want it.

This is a volunteer-run, pre-1.0 open-source project, so these are targets, not a contractual SLA. We will tell you if we need longer.

## Coordinated disclosure

We ask that you give us a reasonable opportunity to investigate and release a fix before disclosing publicly. We aim to do that within 90 days of your report, sooner for severe issues, and we will agree a date with you. If we cannot reach agreement or are unresponsive, you are free to disclose.

## Supported versions

control-plane is pre-1.0. Security fixes are made on `main` and released in the **latest release** only. Older releases are not patched; upgrade to the newest [release](https://github.com/itzzzzzzak/control-plane/releases).

## Scope

**In scope**

- Credential and token handling: storage, encryption (`encryptedStore`), the Postgres store, locking and refresh.
- The OAuth flow: `state`, PKCE, `expectedConnectionId`, redirect and token URL handling.
- Secrets leaking into errors, logs, tool output or `JSON.stringify(error)`.
- Anything that lets a model or untrusted caller send a request, with a credential, to a host or path other than the connector's own (path or base-URL escape, SSRF through cursors or variables).
- Input-validation bypass, and bypass of the `effect` labels or the `beforeExecute` policy (for example a destructive action running when it should be denied, or `control-plane-mcp` performing a write without `--allow-writes`).
- Retry behavior that could duplicate a write.
- Supply-chain issues in the build and release pipeline.

**Out of scope**

- Vulnerabilities in a third-party provider's API or service itself. Report those to the provider.
- Mistakes in a connector's request or response shapes that have no security impact (open a normal issue; `docs-based` connectors are known to need real-world verification).
- Prompt injection that merely causes a model to *request* an action your policy already allows. The kit labels and gates actions; deciding what to allow is the host application's job (see below).
- Issues that need an already-compromised machine, or a credential the reporter was not given.
- Denial of service through very large volumes of legitimate requests, and automated-scanner output without a demonstrated impact.

## Using control-plane safely

For people running it, these reduce your exposure:

- **Use least-privilege, read-only tokens** for the MCP server, and add `--allow-writes` only when needed. Destructive actions are never allowed through `control-plane-mcp`.
- **Keep credentials in the environment or a secret manager,** never in command-line arguments, source control or chat.
- **Expose only the groups you need** (`--group`, `--only`).
- **In production, use a durable, encrypted token store** (`encryptedStore(postgresTokenStore(pool), encryption)`), keep the encryption key in a secret manager, and rotate keys.
- **Treat text from APIs as untrusted.** Messages, tickets and issues are written by other people and may try to instruct your model. Gate writes with `beforeExecute` and, for anything consequential, ask a human.
- **`docs-based` connectors have not been run against the real service.** Try a new one with a test account first.

## Safe harbor

If you act in good faith, follow this policy, avoid accessing data that is not yours, do not disrupt other people's systems, and give us time to fix the issue, we will not pursue or support legal action against you for your research.
