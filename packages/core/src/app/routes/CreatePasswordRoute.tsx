import { useNavigate } from "@tanstack/react-router";
import { CreatePassword } from "../screens/CreatePassword/CreatePassword";

export function CreatePasswordRoute() {
	const navigate = useNavigate();
	return (
		<div className="flex-1 overflow-y-auto">
			<CreatePassword onBack={() => navigate({ to: "/vault" })} />
		</div>
	);
}
