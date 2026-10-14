# Security Policy

ControlPlane will handle credentials and run automations driven by AI agents, so security reports are welcome and taken seriously.

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.** Report it privately:

**[Report a vulnerability](https://github.com/itzzzzzzak/control-plane/security/advisories/new)** (or the repository's **Security** tab, then **Report a vulnerability**).

Include what you can: the issue and its impact, steps to reproduce (a minimal proof of concept is ideal), the affected module and version, and whether real credentials or data were exposed. Redact any live secrets.

## What to expect

This is a volunteer-run, pre-1.0 project, so these are targets, not a contractual SLA: acknowledgement within 3 business days, an initial assessment within 10 business days, a private fix followed by a published GitHub Security Advisory, and credit if you want it. We ask for a reasonable chance to fix before public disclosure (aim: within 90 days, sooner for severe issues).

## Supported versions

Pre-1.0: fixes land on `main` and in the latest release only.

## Scope

**In scope:** handling and storage of credentials and tokens; secrets leaking into errors or logs; data loss or silent overwrite in a sync; one module reaching another's data against the boundary rules; a way for an agent or untrusted input to run an action a policy should have denied; code escaping the sandbox once that module exists.

**Out of scope:** vulnerabilities in third-party services (report to them); issues that need an already compromised machine; automated-scanner output without demonstrated impact.
