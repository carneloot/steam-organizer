# Project guidance

## Disposable application data

This is a personal project. Existing application data is disposable, and losing it during schema changes is acceptable.

When changing persistence, update the current schema directly. Do not add data-preserving migrations, backfills, or compatibility code solely to retain old data unless the user explicitly requests it. Prefer a clean database reset over migration machinery.

This policy applies to application data, not credentials, deployment state, or shared infrastructure. It does not authorize unrequested deployments or remote database resets.
