import { useEffect, useRef, useCallback } from "react";
import type { AppImage } from "@photos/photos-lib";
import type { DataSourceMode } from "./data-client";
import { LOCAL_URL } from "./data-client";
import { listPhotos, listPhotosSince } from "./data-server-client";
import { photoRecordToAppImage } from "./photoRecordToAppImage";

const POLL_INTERVAL_MS = 30_000;
const RESUME_FETCH_THRESHOLD_MS = 30_000;

interface UsePhotoSyncOptions {
  mode: DataSourceMode;
  onInitialLoad: (images: AppImage[]) => void;
  onMerge: (images: AppImage[]) => void;
  onLoadingChange: (loading: boolean) => void;
  onError: (message: string) => void;
}

export function usePhotoSync({ mode, onInitialLoad, onMerge, onLoadingChange, onError }: UsePhotoSyncOptions): void {
  const cursorRef = useRef<string | null>(null);
  const hiddenAtRef = useRef<number | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const computeCursor = (images: AppImage[]): string | null => {
    if (images.length === 0) return null;
    return images.reduce((max, img) => (img.updatedAt > max.updatedAt ? img : max)).updatedAt;
  };

  const fetchAll = useCallback(async () => {
    onLoadingChange(true);
    try {
      const records = await listPhotos(modeRef.current);
      const images = records.map(photoRecordToAppImage);
      const cursor = computeCursor(images);
      if (cursor) cursorRef.current = cursor;
      onInitialLoad(images);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to load photos");
    } finally {
      onLoadingChange(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchSince = useCallback(async () => {
    const cursor = cursorRef.current;
    if (!cursor) {
      await fetchAll();
      return;
    }
    try {
      const records = await listPhotosSince(cursor, modeRef.current);
      if (records.length > 0) {
        const images = records.map(photoRecordToAppImage);
        const newCursor = computeCursor(images);
        if (newCursor && newCursor > cursor) cursorRef.current = newCursor;
        onMerge(images);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to poll for updates");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const scheduleNextPoll = useCallback(() => {
    stopPolling();
    pollTimerRef.current = setTimeout(async () => {
      await fetchSince();
      scheduleNextPoll();
    }, POLL_INTERVAL_MS);
  }, [fetchSince, stopPolling]);

  const disconnectSSE = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  const connectSSE = useCallback(() => {
    disconnectSSE();
    const es = new EventSource(`${LOCAL_URL}/events`);
    esRef.current = es;
    es.onmessage = () => { void fetchSince(); };
    es.onerror = () => { console.warn("[usePhotoSync] SSE error, reconnecting..."); };
  }, [disconnectSSE, fetchSince]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        hiddenAtRef.current = Date.now();
        if (modeRef.current === "remote") {
          stopPolling();
        } else {
          disconnectSSE();
        }
      } else {
        const hiddenDuration = hiddenAtRef.current != null ? Date.now() - hiddenAtRef.current : Infinity;
        hiddenAtRef.current = null;
        if (modeRef.current === "remote") {
          if (hiddenDuration > RESUME_FETCH_THRESHOLD_MS) void fetchSince();
          scheduleNextPoll();
        } else {
          connectSSE();
          if (hiddenDuration > RESUME_FETCH_THRESHOLD_MS) void fetchSince();
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [stopPolling, disconnectSSE, scheduleNextPoll, connectSSE, fetchSince]);

  useEffect(() => {
    cursorRef.current = null;

    void fetchAll().then(() => {
      if (mode === "local") {
        connectSSE();
      } else {
        scheduleNextPoll();
      }
    });

    return () => {
      stopPolling();
      disconnectSSE();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
}
