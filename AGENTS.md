# Project guidance

## Disposable application data

This is a personal project. Existing application data is disposable, and losing it during schema changes is acceptable.

For every database schema change, add a new numbered SQL migration in `web/migrations`. Do not edit existing migrations.

Keep migrations simple. Destructive schema changes are acceptable. Do not add backfills, compatibility layers, staged rollouts, or other production-grade machinery solely to preserve disposable data unless explicitly requested.

This policy applies to application data, not credentials, deployment state, or shared infrastructure. It does not authorize unrequested deployments or remote database resets.
