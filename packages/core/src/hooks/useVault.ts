import { usePlatform } from "../context/PlatformContext";
import type { EncryptedEntry } from "../vault-format";

export interface EntrySummary {
  id: string;
  site: string;
  username: string;
}

export interface UseVault {
  entries: EntrySummary[];
  isLocked: boolean;
  unlock(password: string): Promise<void>;
  lock(): Promise<void>;
  addEntry(plaintext: Omit<EntrySummary, "id"> & { password: string }): Promise<void>;
  updateEntry(id: string, plaintext: Partial<EntrySummary> & { password?: string }): Promise<void>;
  deleteEntry(id: string): Promise<void>;
  changePassword(newPassword: string): Promise<void>;
  moveVault(): Promise<void>;
}

export function useVault(): UseVault {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _platform = usePlatform();
  throw new Error("TODO: implement useVault");
}

export type { EncryptedEntry };
