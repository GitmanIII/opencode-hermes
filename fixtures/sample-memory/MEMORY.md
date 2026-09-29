Build: the project uses pnpm; run `pnpm build` from the repo root. Node 20 is required.
§
CI runs GitHub Actions; the test job must stay under 5 minutes.
§
The database is Postgres 16; migrations run via `pnpm db:migrate`.
