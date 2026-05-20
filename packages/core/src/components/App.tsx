import { useVault } from "../hooks/useVault";
import { UnlockScreen } from "./UnlockScreen";
import { EntryList } from "./EntryList";

export function App() {
  const vault = useVault();
  if (vault.isLocked) return <UnlockScreen />;
  return <EntryList />;
}
