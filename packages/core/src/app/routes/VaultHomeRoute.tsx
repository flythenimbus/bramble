import { useNavigate } from "@tanstack/react-router";
import { VaultHome } from "../screens/VaultHome/VaultHome";

export function VaultHomeRoute() {
	const navigate = useNavigate();
	return <VaultHome onCreateNew={() => navigate({ to: "/vault/new" })} />;
}
