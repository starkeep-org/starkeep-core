## Data vs metadata and app data architecture

When designing the data architecture for an app, choices must be made regarding how the data should be stored and managed.

Starkeep provides two primary abstractions for this purpose: data and metadata. It is essential to design the data architecture in a way that uses these abstractions appropriately.

### Data

The most fundamental property of data is ontological independence: data entities must be able to exist and "make sense" on their own, independent of all other data or metadata entities. For example, a photo is a data because it does not depend on any other entity for its "meaningful existence" (excepting an interpreter, which is discussed next). By contrast, a photo caption is not data, because the caption cannot exist and does not make sense as such without the photo that it is about.

Starkeep is designed so that data is easily shared across apps running on the system. This is accomplished by means of a global data type registry. All data types are globally registered so that the semantics of the data type can be clearly defined, and so different apps can understand the semantics of the types and use them.

In a local multi-app deployment, the **data-server is the authoritative owner of this global registry**. App packages export their type definitions; the data-server imports and registers them, validating every write at the shared database boundary. Apps themselves do not maintain their own type registries.

In Starkeep, data is also designed to be portable. This is accomplished by using (with rare exceptions) a file to store each piece of data. Using files provides a number of benefits, not least of which is a straightforward mapping with filesystems, including locally.

In Starkeep, indexing and bookeeping of data is accomplished using the records table in the core database. This table stores the status and path of all files in the shared system along with other properties common to all data. The records table also includes a `content` column for the purpose of storing substantive content in the database record itself. The content property should be rarely used, and only in cases where there is a specific reason to store substantive data content in the database record itself instead of in the data file.

### Metadata

The most fundamental property of metadata is ontological dependence: metadata is always "about" a particular piece of data, and can never meaningfully stand alone.

Starkeep does not expect metadata to be inherently shared or portable, and so the design goals for data do not apply.

While metadata types are also registered, they are registered under a per-app namespace. Thus the exact same metadata types are generally not reusable across apps. This is so each can define the semantics of and use metadata as it wishes.

Metadata is also generally represented in the metadata database tables, not as files. However, metadata database records may reference files.

Because metadata is app-specific, **metadata generators are owned and run by the app that defines them**, not by the data-server. In a thin-client deployment, this means:
- The app runs generators locally (on the raw bytes or payload it already holds)
- The app pushes results to the data-server via `POST /data/metadata`
- The data-server stores them in the shared `metadata_sync` table, making them available to other readers

### Design Heuristics

- When designing the data architecture for an app, it is essential to decide what is data and what is metadata. This will have a major impact on the effectiveness of the app.
- Always remember that data types are globally registered and that data generally kept in files, designed to be shared across apps and portable. The data records table is for indexing and bookkeeping purposes, not primarily for storing substantive content. Metadata is registered within the app namespace, is primarily kept in a database, is not designed to be shared across or portable.
- More abstract data types should generally reference more concrete data types, rather than the other way around. For example, "task groups" (more abstract) should reference the "tasks" (more concrete) they contain, while "tasks" themselves should not reference their group. Note that defined this way, task groups are data - a task group can exist meaningfully even without any reference to any tasks (it would be empty, but that is still meaningful).
