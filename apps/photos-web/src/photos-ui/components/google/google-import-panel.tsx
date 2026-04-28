import React, { useState, useCallback } from "react";
import type { GoogleAlbum, GoogleMediaItem } from "@/photos-lib";

type View = "albums" | "photos";

interface GoogleImportPanelProps {
  onImportComplete: (count: number) => void;
  onClose: () => void;
}

export function GoogleImportPanel({ onImportComplete, onClose }: GoogleImportPanelProps) {
  const [view, setView] = useState<View>("albums");
  const [albums, setAlbums] = useState<GoogleAlbum[]>([]);
  const [albumsLoading, setAlbumsLoading] = useState(false);
  const [albumsLoaded, setAlbumsLoaded] = useState(false);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [mediaItems, setMediaItems] = useState<GoogleMediaItem[]>([]);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaNextPage, setMediaNextPage] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [connected, setConnected] = useState(false);

  const connect = () => {
    window.location.href = "/api/google/oauth";
  };

  const loadAlbums = useCallback(async () => {
    setAlbumsLoading(true);
    try {
      const res = await fetch("/api/google/albums");
      if (res.status === 401 || res.status === 403) { setConnected(false); return; }
      setConnected(true);
      const data = (await res.json()) as { albums: GoogleAlbum[] };
      setAlbums(data.albums);
      setAlbumsLoaded(true);
    } finally {
      setAlbumsLoading(false);
    }
  }, []);

  const loadPhotos = useCallback(async (albumId: string | null, pageToken?: string) => {
    setMediaLoading(true);
    try {
      const params = new URLSearchParams();
      if (albumId) params.set("albumId", albumId);
      if (pageToken) params.set("pageToken", pageToken);
      const res = await fetch(`/api/google/list?${params}`);
      const data = (await res.json()) as { mediaItems: GoogleMediaItem[]; nextPageToken: string | null };
      if (pageToken) {
        setMediaItems((prev) => [...prev, ...data.mediaItems]);
      } else {
        setMediaItems(data.mediaItems);
      }
      setMediaNextPage(data.nextPageToken);
    } finally {
      setMediaLoading(false);
    }
  }, []);

  const openAlbum = (albumId: string | null) => {
    setSelectedAlbumId(albumId);
    setMediaItems([]);
    setSelected(new Set());
    setView("photos");
    void loadPhotos(albumId);
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const item of mediaItems) next.add(item.id);
      return next;
    });
  };

  const deselectAll = () => setSelected(new Set());

  const importSelected = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setImporting(true);
    setImportProgress({ done: 0, total: ids.length });

    let done = 0;
    for (const mediaItemId of ids) {
      await fetch("/api/google/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaItemId }),
      });
      done++;
      setImportProgress({ done, total: ids.length });
    }

    setImporting(false);
    onImportComplete(ids.length);
  };

  // Initial load
  if (!albumsLoaded && !albumsLoading) {
    void loadAlbums();
  }

  if (!connected && albumsLoaded) {
    return (
      <div style={panelStyle}>
        <PanelHeader title="Import from Google Photos" onClose={onClose} />
        <div style={{ padding: 32, textAlign: "center" }}>
          <p style={{ color: "#aaa", marginBottom: 16 }}>
            Connect your Google Photos account to import photos.
          </p>
          <button onClick={connect} style={primaryButtonStyle}>
            Connect Google Photos
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={panelStyle}>
      <PanelHeader title="Import from Google Photos" onClose={onClose} />

      {/* Tab bar */}
      <div style={{ display: "flex", borderBottom: "1px solid rgba(255,255,255,0.1)", padding: "0 16px" }}>
        {view === "photos" && (
          <button
            onClick={() => setView("albums")}
            style={{ ...tabButtonStyle, color: "#aaa" }}
          >
            ← Albums
          </button>
        )}
        <button
          onClick={() => openAlbum(null)}
          style={{ ...tabButtonStyle, color: view === "photos" && selectedAlbumId === null ? "#fff" : "#aaa" }}
        >
          All Photos
        </button>
      </div>

      {view === "albums" && (
        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {albumsLoading && <div style={loadingStyle}>Loading albums...</div>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {albums.map((album) => (
              <div
                key={album.id}
                onClick={() => openAlbum(album.id)}
                style={{
                  width: 140,
                  cursor: "pointer",
                  borderRadius: 6,
                  overflow: "hidden",
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.1)",
                }}
              >
                {album.coverPhotoBaseUrl ? (
                  <img
                    src={`${album.coverPhotoBaseUrl}=w140-h100-c`}
                    style={{ width: 140, height: 100, objectFit: "cover", display: "block" }}
                    alt={album.title}
                  />
                ) : (
                  <div style={{ width: 140, height: 100, background: "#333" }} />
                )}
                <div style={{ padding: "6px 8px" }}>
                  <div style={{ color: "#ddd", fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {album.title}
                  </div>
                  <div style={{ color: "#666", fontSize: 11 }}>{album.mediaItemsCount} items</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {view === "photos" && (
        <>
          <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
            {mediaLoading && mediaItems.length === 0 && (
              <div style={loadingStyle}>Loading photos...</div>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {mediaItems.map((item) => (
                <div
                  key={item.id}
                  onClick={() => toggleSelect(item.id)}
                  style={{
                    position: "relative",
                    width: 100,
                    height: 80,
                    cursor: "pointer",
                    flexShrink: 0,
                    borderRadius: 3,
                    overflow: "hidden",
                    border: selected.has(item.id) ? "2px solid #fff" : "2px solid transparent",
                  }}
                >
                  <img
                    src={`${item.baseUrl}=w100-h80-c`}
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                    alt={item.filename}
                  />
                  {selected.has(item.id) && (
                    <div
                      style={{
                        position: "absolute",
                        top: 4,
                        right: 4,
                        width: 18,
                        height: 18,
                        background: "#fff",
                        borderRadius: "50%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 12,
                        color: "#000",
                        fontWeight: 700,
                      }}
                    >
                      ✓
                    </div>
                  )}
                </div>
              ))}
            </div>
            {mediaNextPage && !mediaLoading && (
              <button
                onClick={() => void loadPhotos(selectedAlbumId, mediaNextPage)}
                style={{ ...secondaryButtonStyle, marginTop: 16 }}
              >
                Load more
              </button>
            )}
          </div>

          {/* Bottom import bar */}
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", padding: "12px 16px", flexShrink: 0 }}>
            {importProgress ? (
              <div>
                <div style={{ color: "#aaa", fontSize: 13, marginBottom: 8 }}>
                  {importProgress.done === importProgress.total
                    ? `✓ ${importProgress.done} photos imported`
                    : `Importing ${importProgress.done} of ${importProgress.total}...`}
                </div>
                <div style={{ height: 4, background: "rgba(255,255,255,0.1)", borderRadius: 2 }}>
                  <div
                    style={{
                      height: "100%",
                      background: "#fff",
                      borderRadius: 2,
                      width: `${(importProgress.done / importProgress.total) * 100}%`,
                      transition: "width 0.2s",
                    }}
                  />
                </div>
                {importProgress.done === importProgress.total && (
                  <button onClick={onClose} style={{ ...primaryButtonStyle, marginTop: 12 }}>
                    View in Library
                  </button>
                )}
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={selectAllVisible} style={secondaryButtonStyle}>Select All</button>
                  <button onClick={deselectAll} style={secondaryButtonStyle}>Deselect All</button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  {selected.size > 0 && (
                    <span style={{ color: "#aaa", fontSize: 13 }}>{selected.size} selected</span>
                  )}
                  <button
                    onClick={() => void importSelected()}
                    disabled={selected.size === 0 || importing}
                    style={{ ...primaryButtonStyle, opacity: selected.size === 0 ? 0.4 : 1 }}
                  >
                    Import Selected
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderBottom: "1px solid rgba(255,255,255,0.1)", flexShrink: 0 }}>
      <span style={{ color: "#fff", fontWeight: 600, fontSize: 15 }}>{title}</span>
      <button onClick={onClose} style={{ background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 20, padding: 0 }}>×</button>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "#1a1a1a",
  zIndex: 1100,
  display: "flex",
  flexDirection: "column",
};

const loadingStyle: React.CSSProperties = {
  color: "#666",
  fontSize: 14,
  textAlign: "center",
  padding: 32,
};

const primaryButtonStyle: React.CSSProperties = {
  background: "#fff",
  color: "#000",
  border: "none",
  borderRadius: 4,
  padding: "8px 16px",
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 13,
};

const secondaryButtonStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.1)",
  color: "#ddd",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 4,
  padding: "6px 12px",
  cursor: "pointer",
  fontSize: 13,
};

const tabButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: "10px 0",
  marginRight: 16,
  cursor: "pointer",
  fontSize: 13,
};
