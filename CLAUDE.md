For functionality and implementation details, see docs/README.md

Don't implement things that aren't needed now (or only because they're expected to be potentially needed in the future). For example, database migrations are not needed when in development, because we can just throw away the data - that's typically a production concern. It's counterproductive to try to implement migrations in a context where we aren't thinking about or testing migrations.

Conversely, anything that does get implemented must be fully hooked up to the relevant system so we can actually test how it works. Implementing disconnected modules create an impression that more has been done than we thought and causes gotchas later.

When working with shared or app specific data, refer to docs/shared-vs-app-specific-data.md.

Use the Typescript LSP proactively as needed.
Use Kysely when writing new SQL or modifying existing SQL.