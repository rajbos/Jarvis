# Security Policy

## Supported Versions

Only the latest version on the `main` branch of this repository is actively supported with security updates.

| Branch | Supported |
| ------ | --------- |
| `main` | ✅ Yes    |
| Others | ❌ No     |

## Reporting a Vulnerability

**Please do not open public GitHub issues for security vulnerabilities.**

Report security vulnerabilities via GitHub's private security advisory feature:

1. Go to the [rajbos/Jarvis Security Advisories](https://github.com/rajbos/Jarvis/security/advisories) page
2. Click **"New draft security advisory"**
3. Describe the vulnerability, steps to reproduce, and potential impact

This keeps the disclosure private until a fix is in place.

## Response Timeline

| Stage        | Target      |
| ------------ | ----------- |
| Acknowledge  | Within 7 days  |
| Triage       | Within 14 days |
| Patch/fix    | Within 90 days (for verified vulnerabilities) |

## Scope

Jarvis handles sensitive data that warrants careful security consideration:

- **GitHub OAuth tokens** — used to authenticate with the GitHub API
- **Personal Access Tokens (PATs)** — stored locally for repository access
- **Encrypted local secrets** — stored in a SQLite database using DPAPI-backed encryption via Electron's `safeStorage`

Vulnerabilities affecting the confidentiality, integrity, or availability of any of the above are in scope.

## Out of Scope

The following are **not** considered in-scope vulnerabilities:

- Issues in third-party services or dependencies (report those upstream)
- Vulnerabilities that require physical access to the user's machine
- Issues in Ollama or other locally-hosted services Jarvis connects to
- Social engineering attacks

## Acknowledgements

We appreciate responsible disclosure and will acknowledge reporters in the release notes for patches addressing their findings (unless they prefer to remain anonymous).
