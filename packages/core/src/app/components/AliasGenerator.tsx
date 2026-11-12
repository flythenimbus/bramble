import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { AtSign, Check, Copy, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { aliasErrorMessage, aliasSiteOf } from "../../aliases";
import { usePlatform } from "../../context/PlatformContext";
import { useAliasProvider } from "../../hooks/useAliasProvider";
import { Button } from "./ui/button";
import { TextField } from "./ui/text-field";

type State =
	| { kind: "idle" }
	| { kind: "busy" }
	| { kind: "done"; address: string }
	| { kind: "error"; message: string };

/**
 * An email alias on its own, for an address needed before there is a login to put it in (#120).
 * Creating one spends the provider allowance, so it happens only on the button, never on its own.
 * Bramble keeps no record of it: the provider's dashboard is where it lives. See
 * docs/email-aliases.md.
 */
export function AliasGenerator() {
	const { t } = useLingui();
	const navigate = useNavigate();
	const { clipboard } = usePlatform();
	const aliases = useAliasProvider();
	const [site, setSite] = useState("");
	const [state, setState] = useState<State>({ kind: "idle" });
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!copied) return;
		const id = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(id);
	}, [copied]);

	if (!aliases.enabled) {
		return (
			<div className="space-y-3">
				<p className="text-sm text-muted-foreground">
					<Trans>Connect an alias provider to create addresses here.</Trans>
				</p>
				<Button
					variant="secondary"
					size="sm"
					onClick={() => void navigate({ to: "/settings", search: { tab: "aliases" } })}
				>
					<Trans>Set up aliases</Trans>
				</Button>
			</div>
		);
	}

	const create = async () => {
		setState({ kind: "busy" });
		setCopied(false);
		try {
			setState({ kind: "done", address: await aliases.generate(aliasSiteOf(site)) });
		} catch (e) {
			setState({ kind: "error", message: aliasErrorMessage(e) });
		}
	};

	const copy = async (address: string) => {
		try {
			await clipboard.copy(address);
			setCopied(true);
		} catch {
			// Clipboard can be blocked or unfocused; the address is on screen either way.
		}
	};

	return (
		<div className="space-y-3">
			<TextField
				label={t`Website (optional)`}
				type="text"
				autoComplete="off"
				value={site}
				onChange={(e) => setSite(e.target.value)}
			/>
			<Button onClick={() => void create()} disabled={state.kind === "busy"} className="gap-1.5">
				{state.kind === "busy" ? (
					<Loader2 className="w-4 h-4 animate-spin" />
				) : (
					<AtSign className="w-4 h-4" />
				)}
				<Trans>Create alias</Trans>
			</Button>
			{state.kind === "done" && (
				<div className="rounded-lg border border-border bg-muted/30 p-3 flex items-center gap-2">
					<span className="flex-1 min-w-0 break-all font-mono text-sm">{state.address}</span>
					<Button
						variant="ghost"
						size="none"
						onClick={() => void copy(state.address)}
						className="p-1.5 rounded-md shrink-0"
						aria-label={t`Copy`}
					>
						{copied ? (
							<Check className="w-3.5 h-3.5 text-primary" />
						) : (
							<Copy className="w-3.5 h-3.5" />
						)}
					</Button>
				</div>
			)}
			{state.kind === "error" && (
				// Plain text: part of this can be the provider's own message.
				<p className="text-xs text-destructive">{state.message}</p>
			)}
		</div>
	);
}
