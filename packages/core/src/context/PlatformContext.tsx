import { createContext, useContext, type ReactNode } from "react";
import type { StorageAdapter } from "../adapters/storage";
import type { CryptoAdapter } from "../adapters/crypto";
import type { AutofillAdapter } from "../adapters/autofill";

export interface Platform {
  storage: StorageAdapter;
  crypto: CryptoAdapter;
  autofill: AutofillAdapter;
}

const PlatformContext = createContext<Platform | null>(null);

export function PlatformProvider({
  platform,
  children,
}: {
  platform: Platform;
  children: ReactNode;
}) {
  return (
    <PlatformContext.Provider value={platform}>
      {children}
    </PlatformContext.Provider>
  );
}

export function usePlatform(): Platform {
  const ctx = useContext(PlatformContext);
  if (!ctx) throw new Error("usePlatform called outside PlatformProvider");
  return ctx;
}
