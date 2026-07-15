# Security policy

## Scope

This project is a static, client-side application. It does not send images or saved work data to an external API. Files selected by the user, imported ZIP archives, and browser-local save slots are in scope for security reports.

## Reporting a vulnerability

If this repository has GitHub private vulnerability reporting enabled, use **Security → Report a vulnerability**. Do not include exploit code, personal images, cookies, access tokens, or other secrets in a public issue.

If private reporting is unavailable, open a minimal public issue asking the maintainer for a private contact channel; include only a high-level description.

## Safe operation notes

- Imported ZIP files are treated as untrusted. The app limits archive size, entry count, frame coordinates, and output names.
- Browser save slots can retain image data. Use **すべての一時保存を削除** after working on a shared computer.
- For sensitive images, use a dedicated browser profile and a dedicated GitHub Pages origin or custom domain.

## Maintainer checklist

- Enable Secret Scanning and Push Protection in GitHub repository settings.
- Protect the default branch and review workflow changes.
- Keep bundled third-party libraries current, verifying the hashes recorded in `THIRD_PARTY_NOTICES.md`.
