# Starkeep Data Protocol

Starkeep is a platform for building apps where users own their data. Each user gets isolated cloud infrastructure — their own database, file storage, and API — that belongs to them, not the app developer. App developers build on a shared, governed data layer through an SDK, without ever having direct access to user data.

Apps built on Starkeep run offline-first: all data operations happen locally, and the local state syncs to the user's cloud on demand.

## What You Can Build

Any app that stores structured user data:

- Photo and media management
- Document editors and note-taking
- Task managers and to-do lists
- AI assistants and conversation history
- File browsers and storage managers
- Any multi-device app where users control their own storage

## Key Capabilities

| Capability | Description |
|---|---|
| **Records** | Typed, schematized data units with unique IDs and optional file attachments |
| **Metadata** | Derived properties computed from records by a pluggable generator system |
| **Search** | Full-text and metadata-aware querying across all records |
| **Aggregations** | Counts, storage totals, and date histograms |
| **Sync** | Bidirectional local-to-cloud sync with deterministic conflict resolution |
| **Access control** | Fine-grained policies controlling who can read, write, or share data |

## Documentation

- [Concepts](concepts.md) — The core ideas: records, metadata, types, sync, access control, and storage adapters
- [Getting Started](getting-started.md) — Local setup and cloud deployment walkthrough
- [Building an App](building-an-app.md) — How to define types, store data, generate metadata, search, sync, and control access
- [Architecture](architecture.md) — System layers, local and cloud topology, package overview, and design principles
- [Deployment](deployment.md) — What gets provisioned per user, how provisioning works, and costs

### Apps

- [Admin](../apps/admin-web/README.md) — Command center: cloud setup wizard, dashboard, permissions management
- [Data Server](../apps/data-server/README.md) — Local HTTP hub: configuration, file watching, sync, and the HTTP API
- [Photos](../apps/photos-web/README.md) — Photo management app (thin-client pattern example)
- [File Browser](../apps/file-browser/README.md) — Read-only record and metadata inspector

### Reference

- [Data vs. Metadata App Architecture](data-vs-metadata-app-architecture.md) — Design heuristics for deciding what is data and what is metadata
