import { usePlatform } from "../context/PlatformContext";

export interface Credentials {
  site: string;
  username: string;
  password: string;
  totp?: string;
  notes?: string;
  isLoading: boolean;
}

export function useCredentials(_entryId: string): Credentials {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _platform = usePlatform();
  throw new Error("TODO: implement useCredentials");
}
