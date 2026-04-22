use anyhow::Result;
use bytes::Bytes;
use fuse3::path::prelude::*;
use fuse3::path::Session;
use fuse3::{Errno, MountOptions, Result as FuseResult};
use futures::stream;
use futures::StreamExt;
use opendal::Operator;
use std::ffi::{OsStr, OsString};
use std::num::NonZeroU32;
use std::time::{Duration, SystemTime};
use tracing::{debug, error, info, warn};

/// FUSE filesystem implementation backed by OpenDAL
pub struct OpenDALFilesystem {
    operator: Operator,
}

impl OpenDALFilesystem {
    pub fn new(operator: Operator) -> Self {
        Self { operator }
    }

    /// Mount the filesystem at the given path
    pub async fn mount(self, mount_point: &str) -> Result<()> {
        info!(mount_point = %mount_point, "Mounting FUSE filesystem");

        tokio::fs::create_dir_all(mount_point).await?;

        let mut mount_options = MountOptions::default();
        mount_options.allow_other(true).fs_name("opendal");

        Session::new(mount_options)
            .mount(self, mount_point)
            .await?
            .await?;

        Ok(())
    }
}

impl PathFilesystem for OpenDALFilesystem {
    type DirEntryStream<'a> =
        futures::stream::Iter<std::vec::IntoIter<FuseResult<DirectoryEntry>>>
    where
        Self: 'a;

    type DirEntryPlusStream<'a> =
        futures::stream::Iter<std::vec::IntoIter<FuseResult<DirectoryEntryPlus>>>
    where
        Self: 'a;

    fn init(&self, _req: Request) -> impl std::future::Future<Output = FuseResult<ReplyInit>> + Send {
        async move {
            info!("FUSE filesystem initialized");

            Ok(ReplyInit {
                max_write: NonZeroU32::new(1024 * 1024).unwrap_or(NonZeroU32::new(16 * 1024).unwrap()),
            })
        }
    }

    fn destroy(&self, _req: Request) -> impl std::future::Future<Output = ()> + Send {
        async move {
            info!("FUSE filesystem destroyed");
        }
    }

    fn getattr(
        &self,
        _req: Request,
        path: Option<&OsStr>,
        _fh: Option<u64>,
        _flags: u32,
    ) -> impl std::future::Future<Output = FuseResult<ReplyAttr>> + Send {
        async move {
            let path = path.ok_or_else(|| Errno::from(libc::ENOENT))?;
            let path_str = path.to_str().ok_or_else(|| Errno::from(libc::EINVAL))?;
            let path_str = path_str.trim_start_matches('/');

            debug!(path = %path_str, "getattr");

            if path_str.is_empty() {
                let now = SystemTime::now();
                let attr = FileAttr {
                    size: 0,
                    blocks: 0,
                    atime: now,
                    mtime: now,
                    ctime: now,
                    kind: FileType::Directory,
                    perm: 0o755,
                    nlink: 2,
                    uid: 0,
                    gid: 0,
                    rdev: 0,
                    blksize: 4096,
                };
                return Ok(ReplyAttr {
                    ttl: Duration::from_secs(1),
                    attr,
                });
            }

            match self.operator.stat(path_str).await {
                Ok(metadata) => {
                    let kind = if metadata.is_dir() {
                        FileType::Directory
                    } else {
                        FileType::RegularFile
                    };

                    let size = metadata.content_length();
                    let mtime = metadata
                        .last_modified()
                        .map(|dt| SystemTime::UNIX_EPOCH + Duration::from_secs(dt.timestamp() as u64))
                        .unwrap_or_else(SystemTime::now);

                    let attr = FileAttr {
                        size,
                        blocks: (size + 4095) / 4096,
                        atime: mtime,
                        mtime,
                        ctime: mtime,
                        kind,
                        perm: if kind == FileType::Directory { 0o755 } else { 0o644 },
                        nlink: if kind == FileType::Directory { 2 } else { 1 },
                        uid: 0,
                        gid: 0,
                        rdev: 0,
                        blksize: 4096,
                    };

                    Ok(ReplyAttr {
                        ttl: Duration::from_secs(1),
                        attr,
                    })
                }
                Err(e) if e.kind() == opendal::ErrorKind::NotFound => {
                    debug!(path = %path_str, "File not found");
                    Err(Errno::from(libc::ENOENT))
                }
                Err(e) if e.kind() == opendal::ErrorKind::PermissionDenied => {
                    warn!(path = %path_str, "Permission denied");
                    Err(Errno::from(libc::EACCES))
                }
                Err(e) => {
                    error!(path = %path_str, error = %e, "Failed to stat file");
                    Err(Errno::from(libc::EIO))
                }
            }
        }
    }

    fn read(
        &self,
        _req: Request,
        path: Option<&OsStr>,
        _fh: u64,
        offset: u64,
        size: u32,
    ) -> impl std::future::Future<Output = FuseResult<ReplyData>> + Send {
        async move {
            let path = path.ok_or_else(|| Errno::from(libc::ENOENT))?;
            let path_str = path.to_str().ok_or_else(|| Errno::from(libc::EINVAL))?;
            let path_str = path_str.trim_start_matches('/');

            debug!(path = %path_str, offset = %offset, size = %size, "read");

            if size == 0 {
                return Ok(ReplyData { data: Bytes::new() });
            }

            let metadata = match self.operator.stat(path_str).await {
                Ok(metadata) => metadata,
                Err(e) if e.kind() == opendal::ErrorKind::NotFound => {
                    debug!(path = %path_str, "File not found");
                    return Err(Errno::from(libc::ENOENT));
                }
                Err(e) if e.kind() == opendal::ErrorKind::PermissionDenied => {
                    warn!(path = %path_str, "Permission denied reading file");
                    return Err(Errno::from(libc::EACCES));
                }
                Err(e) => {
                    error!(path = %path_str, error = %e, "Failed to stat file");
                    return Err(Errno::from(libc::EIO));
                }
            };

            if metadata.is_dir() {
                return Err(Errno::from(libc::EISDIR));
            }

            let file_size = metadata.content_length();
            if offset >= file_size {
                return Ok(ReplyData { data: Bytes::new() });
            }

            let end = std::cmp::min(offset.saturating_add(u64::from(size)), file_size);

            match self.operator.read_with(path_str).range(offset..end).await {
                Ok(buf) => Ok(ReplyData { data: buf.to_bytes() }),
                Err(e) if e.kind() == opendal::ErrorKind::NotFound => {
                    debug!(path = %path_str, "File not found");
                    Err(Errno::from(libc::ENOENT))
                }
                Err(e) if e.kind() == opendal::ErrorKind::PermissionDenied => {
                    warn!(path = %path_str, "Permission denied reading file");
                    Err(Errno::from(libc::EACCES))
                }
                Err(e) => {
                    error!(path = %path_str, error = %e, "Failed to read file");
                    Err(Errno::from(libc::EIO))
                }
            }
        }
    }

    fn write(
        &self,
        _req: Request,
        path: Option<&OsStr>,
        _fh: u64,
        offset: u64,
        data: &[u8],
        _write_flags: u32,
        _flags: u32,
    ) -> impl std::future::Future<Output = FuseResult<ReplyWrite>> + Send {
        let data = data.to_vec();
        let data_len = data.len();
        async move {
            let path = path.ok_or_else(|| Errno::from(libc::ENOENT))?;
            let path_str = path.to_str().ok_or_else(|| Errno::from(libc::EINVAL))?;
            let path_str = path_str.trim_start_matches('/');

            debug!(path = %path_str, offset = %offset, size = %data_len, "write");

            if offset != 0 {
                warn!(path = %path_str, offset = %offset, "Offset writes not supported");
                return Err(Errno::from(libc::ENOSYS));
            }

            match self.operator.write(path_str, data).await {
                Ok(_) => Ok(ReplyWrite {
                    written: data_len as u32,
                }),
                Err(e) if e.kind() == opendal::ErrorKind::PermissionDenied => {
                    warn!(path = %path_str, "Permission denied writing file");
                    Err(Errno::from(libc::EACCES))
                }
                Err(e) => {
                    error!(path = %path_str, error = %e, "Failed to write file");
                    Err(Errno::from(libc::EIO))
                }
            }
        }
    }

    fn readdir(
        &self,
        _req: Request,
        path: &OsStr,
        _fh: u64,
        offset: i64,
    ) -> impl std::future::Future<Output = FuseResult<ReplyDirectory<Self::DirEntryStream<'_>>>> + Send {
        async move {
            let path_str = path.to_str().ok_or_else(|| Errno::from(libc::EINVAL))?;
            let path_str = path_str.trim_start_matches('/');

            debug!(path = %path_str, offset = %offset, "readdir");

            let prefix = if path_str.is_empty() {
                String::new()
            } else {
                format!("{}/", path_str)
            };

            match self.operator.list(&prefix).await {
                Ok(entries) => {
                    let mut out: Vec<FuseResult<DirectoryEntry>> = Vec::with_capacity(entries.len() + 2);

                    out.push(Ok(DirectoryEntry {
                        kind: FileType::Directory,
                        name: ".".into(),
                        offset: 1,
                    }));
                    out.push(Ok(DirectoryEntry {
                        kind: FileType::Directory,
                        name: "..".into(),
                        offset: 2,
                    }));

                    for (idx, entry) in entries.iter().enumerate() {
                        let metadata = entry.metadata();
                        let name = entry.name().trim_end_matches('/');

                        out.push(Ok(DirectoryEntry {
                            kind: if metadata.is_dir() {
                                FileType::Directory
                            } else {
                                FileType::RegularFile
                            },
                            name: name.into(),
                            offset: (idx + 3) as i64,
                        }));
                    }

                    let start = if offset <= 0 { 0 } else { offset as usize };
                    let entries = if start >= out.len() {
                        Vec::new()
                    } else {
                        out.into_iter().skip(start).collect()
                    };

                    Ok(ReplyDirectory {
                        entries: stream::iter(entries),
                    })
                }
                Err(e) if e.kind() == opendal::ErrorKind::NotFound => {
                    debug!(path = %path_str, "Directory not found");
                    Err(Errno::from(libc::ENOENT))
                }
                Err(e) if e.kind() == opendal::ErrorKind::PermissionDenied => {
                    warn!(path = %path_str, "Permission denied reading directory");
                    Err(Errno::from(libc::EACCES))
                }
                Err(e) => {
                    error!(path = %path_str, error = %e, "Failed to read directory");
                    Err(Errno::from(libc::EIO))
                }
            }
        }
    }
}
