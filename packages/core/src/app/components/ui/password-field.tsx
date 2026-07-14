import { useLingui } from "@lingui/react/macro";
import { Eye, EyeOff } from "lucide-react";
import { type ComponentProps, forwardRef, useState } from "react";
import { TextField } from "./text-field";

// A TextField that masks its value and carries a show/hide toggle, so every
// password entry across the app reveals typos consistently (issue #14). Owns the
// reveal state and the eye button; everything else passes straight through to
// TextField (label, error, value/onChange, react-hook-form register, etc.).
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
