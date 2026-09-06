# Security

Relay 0.1.0 is under development. No version has completed an independent security audit; there is not yet a production-supported release line.

Do not use disposable development builds as your sole copy of an important workspace. Keep recovery material private. Use trusted browsers, trusted extension builds, disk encryption and operating-system account protections.

## Reporting vulnerabilities

Before publishing a public service/repository, the maintainer must configure a private vulnerability reporting channel (for example GitHub private vulnerability reporting) and add its verified address here. No reporting email or public repository is invented by this project.

For this local development copy, report privately to the project owner. Do not post account numbers, recovery material, browser profile archives, decrypted URLs, private keys, or exploit details in a public issue. A useful report includes affected commit/version, a minimal reproduction using synthetic data, impact, and proposed mitigation.

The source and protocol are public. Security depends on standard primitives and verified trust boundaries, not obscurity. Read [the exact cryptographic model](docs/CRYPTOGRAPHY.md), [threat model](docs/THREAT-MODEL.md), and [remaining release gates](docs/VALIDATION.md).
