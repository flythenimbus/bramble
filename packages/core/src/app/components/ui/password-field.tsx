import { useLingui } from "@lingui/react/macro";
import { Eye, EyeOff } from "lucide-react";
import { type ComponentProps, forwardRef, useState } from "react";
import { TextField } from "./text-field";

// A TextField that masks its value with a show/hide toggle, so every password entry
// reveals typos consistently (issue #14). Reveal flips type password<->text (the only
// masking that works across all engines: CSS can't un-mask a real password field, and
// Firefox lacks -webkit-text-security). Autofill and the smart-keyboard traits are forced
// off since these are the app's own master-password fields, not OS-managed logins
// (issue #5). These props win over any caller value, so route every password input here.
type PasswordFieldProps = Omit<ComponentProps<typeof TextField>, "type" | "endAdornment">;

export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(
	function PasswordField(props, ref) {
		const { t } = useLingui();
		const [show, setShow] = useState(false);
		return (
			<TextField
				ref={ref}
				{...props}
				type={show ? "text" : "password"}
				autoComplete="off"
				autoCorrect="off"
				autoCapitalize="none"
				spellCheck={false}
				endAdornment={
					<button
						type="button"
						// Reveal is a convenience, not a form control: keep it out of the tab order
						// so Tab moves between password + confirm fields, not onto the eye.
						tabIndex={-1}
						onClick={() => setShow((s) => !s)}
						className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
						aria-label={show ? t`Hide password` : t`Show password`}
					>
						{show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
					</button>
				}
			/>
		);
	},
);
