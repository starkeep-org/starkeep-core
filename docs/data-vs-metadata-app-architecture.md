## Data vs metadata and app data architecture

When designing the data architecture for an app, choices must be made regarding how the data should be stored and managed.

Starkeep provides two primary abstractions for this purpose: data and metadata. It is essential to design the data architecture in a way that uses these abstractions appropriately.

### Data

The most fundamental property of data is ontological independence: data entities must be able to exist and "make sense" on their own, independent of all other data or metadata entities. For example, a photo is a data because it does not depend on any other entity for its "meaningful existence" (excepting an interpreter, which is discussed next). By contrast, a photo caption is not data, because the caption cannot exist and does not make sense as such without the photo that it is about.

Starkeep is designed so that data is easily shared across apps running on the system. This is accomplished by means of a global data type registry. All data types are globally registered so that the semantics of the data type can be clearly defined, and so different apps can understand the semantics of the types and use them.

In a local multi-app deployment, the **data-server is the authoritative owner of this global registry**. App packages export their type definitions; the data-server imports and registers them, validating every write at the shared database boundary. Apps themselves do not maintain their own type registries.

In Starkeep, data is also designed to be portable. This is accomplished by using a file to store each piece of data. Using files provides a number of benefits, not least of which is a straightforward mapping with filesystems, including locally.

In Starkeep, indexing and bookeeping of data is accomplished using the records table in the core database. This table stores the status and path of all files in the shared system along with other properties common to all data. 

### Metadata

The most fundamental property of metadata is ontological dependence: metadata is always "about" a particular piece of data, and can never meaningfully stand alone.

Starkeep does not expect metadata to be inherently shared or portable, and so the design goals for data do not apply.

While metadata types are also registered, they are registered under a per-app namespace. Thus the exact same metadata types are generally not reusable across apps. This is so each can define the semantics of and use metadata as it wishes.

Metadata is also generally represented in the metadata database tables.

### Design Heuristics

- Always remember that data types are globally registered and that data generally kept in files, designed to be shared across apps and portable. The data records table is for indexing and bookkeeping purposes, not for storing substantive content. Metadata is registered within the app namespace, is primarily kept in a database, is not designed to be shared across or portable.