import { useNavigate } from "@tanstack/react-router";
import { Auth } from "../screens/Auth/Auth";

export function AuthRoute() {
	const navigate = useNavigate();
	return <Auth onAuthenticate={() => navigate({ to: "/vault" })} />;
}
