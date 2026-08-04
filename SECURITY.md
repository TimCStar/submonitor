# Security

## Reporting

Please report security issues privately to the repository owner instead of opening a public issue.

## Deployment requirements

- Use a unique administrator password with at least 12 characters.
- Use a random `SUBMONITOR_MASTER_KEY` with at least 32 characters and keep it stable. Changing it makes the stored Sub2API credential unreadable.
- Put SubMonitor behind HTTPS and set `SUBMONITOR_COOKIE_SECURE=true` for internet-facing deployments.
- Restrict network access to the administration site and keep the SQLite data directory private.
- Do not run more than one application instance against the same SQLite database.
- Enable TOTP 2FA from the authenticated “后台安全” panel and keep the authenticator seed separate from the server.
- Login failures are persisted in SQLite and progressively block the account and source address; do not expose the administration endpoint directly without HTTPS and an access-control layer.

Sub2API credentials are encrypted with AES-256-GCM before storage. They are never returned by the HTTP API or rendered in the browser.

The TOTP seed is also encrypted with AES-256-GCM. `SUBMONITOR_MASTER_KEY` must be backed up with the database. If the authenticator is lost, restore the original master key before performing database maintenance to remove the `auth_2fa` setting and enrolling a new authenticator.
