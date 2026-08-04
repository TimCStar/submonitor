# Security

## Reporting

Please report security issues privately to the repository owner instead of opening a public issue.

## Deployment requirements

- Use a unique administrator password with at least 12 characters.
- Use a random `SUBMONITOR_MASTER_KEY` with at least 32 characters and keep it stable. Changing it makes the stored Sub2API credential unreadable.
- Put SubMonitor behind HTTPS and set `SUBMONITOR_COOKIE_SECURE=true` for internet-facing deployments.
- Restrict network access to the administration site and keep the SQLite data directory private.
- Do not run more than one application instance against the same SQLite database.

Sub2API credentials are encrypted with AES-256-GCM before storage. They are never returned by the HTTP API or rendered in the browser.
