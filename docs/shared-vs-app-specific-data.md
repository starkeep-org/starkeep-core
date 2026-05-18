## Shared data and app-specific data

### Shared data

- can be accessed by multiple apps  
- survives uninstall of apps  
- Only standard file types that are declared upfront in the core, but whether data is shared depends on app's intent, not the type (apps may use standard data file types as either shared or app specific data)  
- Always contained in files  
- One main records row per file  
- main records items only have metadata common to all file types  
- one type based metadata table per type also declared upfront with columns preset for the type based metadata properties. Important: all type based metadata must be deterministically derivable from the file. Each type based metadata table is essentially an index/cache of metadata that is available also from the file. 
- is stored under the "shared" top level directory or prefix in object storage, with per-type subdirectories  
- apps declare in their manifest which types they want to operate on and whether they have read or read/write access  
- user grants permission to app to operate on type(s) when installing  
- any data not meeting all the conditions and requirements above is not shared data  
- shared data may be synced between local and cloud as mediated by the local-data-server \<-\> cloud-data-server, and (potentially, when implemented) configurable by the user

### App-specific syncable data

- apps declare an appId namespace  
- App specific data can be accessed only by the owner app (or via an API implemented by the owner app)  
- does not survive uninstall of the owner app locally, but removing the app in one location does not destroy its data in other location, it just stops syncing to the removed location  
- can consist of any combination of database records and/or files
- may include "extra" metadata attached to records, for example captions for images that are not derivable from the file itself  
- all app specific database records must be stored in a namespaced schema or namespaced tables as \<appId\>\_syncable (schema preferred, fall back to tables for dbs like sqlite that don't support schemas)  
- syncable files are stored under an "apps/\<appId\>/syncable" directory or prefix  
- any files stored under that prefix or directory, as well as any database schemas or tables with those name prefixes are syncable as mediated by the local-data-server \<-\> cloud-data-server  
- data is only synced to locations where the relevant app is installed

### App-specific non-syncable data

The system does not provide a managed namespace for app-specific non-syncable
data. The `apps/<appId>/` object-storage prefix is reserved for
`apps/<appId>/syncable/...` — nothing else lives there. Apps that need
non-syncable scratch storage handle it themselves (e.g. their own bucket,
their own database, the user's filesystem); whatever they do, it must stay
out of `shared/...` and out of `apps/<appId>/syncable/...`, and it is not
visible to or governed by the data plane.
