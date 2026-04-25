import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { readCloudConfig } from "./cloud-config";
import type { DataSourceMode } from "./data-client";

const STORAGE_KEY = "starkeep:dataSource";

export const FORCE_REMOTE = process.env.NEXT_PUBLIC_FORCE_REMOTE === "true";

interface DataSourceContextValue {
  mode: DataSourceMode;
  setMode: (m: DataSourceMode) => void;
  remoteAvailable: boolean;
}

export const DataSourceContext = createContext<DataSourceContextValue>({
  mode: "local",
  setMode: () => {},
  remoteAvailable: false,
});

export function useDataSource() {
  return useContext(DataSourceContext);
}

export function DataSourceProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<DataSourceMode>(
    () => FORCE_REMOTE ? "remote" : (localStorage.getItem(STORAGE_KEY) as DataSourceMode) ?? "local",
  );
  const [remoteAvailable, setRemoteAvailable] = useState(false);

  useEffect(() => {
    readCloudConfig().then((c) => setRemoteAvailable(!!c?.apiGatewayUrl));
  }, []);

  const setMode = (m: DataSourceMode) => {
    if (FORCE_REMOTE) return;
    localStorage.setItem(STORAGE_KEY, m);
    setModeState(m);
  };

  return (
    <DataSourceContext.Provider value={{ mode, setMode, remoteAvailable }}>
      {children}
    </DataSourceContext.Provider>
  );
}
