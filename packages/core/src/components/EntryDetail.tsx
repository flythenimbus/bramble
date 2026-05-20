import { useCredentials } from "../hooks/useCredentials";

export function EntryDetail({ entryId }: { entryId: string }) {
  const creds = useCredentials(entryId);
  if (creds.isLoading) return <p>Loading…</p>;
  return (
    <div>
      <h2>{creds.site}</h2>
      <p>TODO: render username, password (masked), totp, copy buttons.</p>
    </div>
  );
}
