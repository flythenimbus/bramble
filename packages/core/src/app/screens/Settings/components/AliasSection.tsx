import { Trans, useLingui } from "@lingui/react/macro";
import { AtSign, Check, ExternalLink, Loader2, RefreshCw, Unplug } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
	ALIAS_PROVIDERS,
	type AliasAccount,
	type AliasDomainOption,
	AliasError,
	type AliasProviderId,
	describeProvider,
	looksLikeDomain,
} from "../../../../aliases";
import { type SaveAliasInput, useAliasProvider } from "../../../../hooks/useAliasProvider";
import { AdvancedDisclosure } from "../../../components/ui/advanced-disclosure";
import { Button } from "../../../components/ui/button";
import { SelectField } from "../../../components/ui/select-field";
import { TextField } from "../../../components/ui/text-field";
import { Section } from "./primitives";

/**
 * What to show for a failure: our sentence, then the provider's own if it gave one.
 *
 * The provider's half is rendered as text and never linked. It is remote-controlled string data,
 * and a measured provider answers a free plan with an upgrade URL inside the message; a clickable
 * link chosen by a remote server, on the screen where an API key was just typed, is a phishing
 * surface. See docs/email-aliases.md.
 */
function messageFor(e: unknown): string {
	if (e instanceof AliasError) {
		return e.providerMessage ? `${e.message} ${e.providerMessage}` : e.message;
	}
	return e instanceof Error ? e.message : String(e);
}

type Status =
	| { kind: "idle" }
	| { kind: "busy" }
	| { kind: "ok"; account: AliasAccount }
	| { kind: "error"; message: string };

/**
 * Email alias provider: the account Bramble asks for a fresh address per site.
 *
 * Configuring a provider is the opt-in for this network egress, so there is no separate master
 * switch. Nothing is contacted until a key is saved, and the host contacted is the one named on
 * screen. See docs/email-aliases.md.
 */
export function AliasSection() {
	const { t } = useLingui();
	const { config, save, disconnect, verify, domains } = useAliasProvider();

	const [provider, setProvider] = useState<AliasProviderId>("addy");
	const [baseUrl, setBaseUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [options, setOptions] = useState<Record<string, string>>({});
	const [domainList, setDomainList] = useState<AliasDomainOption[]>([]);
	const [status, setStatus] = useState<Status>({ kind: "idle" });

	const descriptor = describeProvider(provider);

	// The copy for each provider-specific field. Here rather than in the descriptor so Lingui can
	// extract it; the descriptor decides which fields exist, this decides what they say.
	const fieldLabel = (key: string): string => {
		if (key === "domain") return provider === "catchall" ? t`Your domain` : t`Alias domain`;
		if (key === "format") return t`Alias format`;
		if (key === "mode") return t`Alias style`;
		if (key === "style") return t`Alias style`;
		return key;
	};
	const fieldHint = (key: string): string | undefined => {
		// Three providers have a domain field and none of them mean the same thing by it: Addy
		// cannot create without one, SimpleLogin uses the account default until you pick, and the
		// catch-all one is the user's own domain typed in by hand.
		if (key === "domain") {
			if (provider === "catchall") {
				// Bramble cannot tell whether a catch-all actually works without sending mail, and a
				// typo here produces addresses that look right and quietly go nowhere. So it asks
				// rather than pretends. See docs/email-aliases.md.
				return t`Double-check this. Bramble cannot test it, and a wrong domain gives you addresses that quietly go nowhere.`;
			}
			return provider === "addy"
				? t`Addy needs a domain before it can create an alias.`
				: t`Leave unset for your account's default domain, or pick one of your own.`;
		}
		if (key === "style") return t`Words are easier to read aloud; characters are shorter.`;
		if (key === "format") return t`Leave unset to use your provider account's own default.`;
		// Stated because it is a privacy choice rather than a cosmetic one: a word alias carries
		// the site's name, so the address itself discloses where it is used.
		if (key === "mode")
			return t`Word aliases include the site's name, which is easier to recognise but tells anyone who sees the address where you used it. UUID aliases reveal nothing.`;
		return undefined;
	};

	// Adopt the saved provider once it loads. The key is deliberately not restored: it is wrapped
	// under the vault key and this screen has no reason to hold the plaintext, so the field stays
	// empty and saving with it empty keeps what is already stored.
	useEffect(() => {
		if (!config) return;
		setProvider(config.provider);
		setBaseUrl(config.baseUrl ?? "");
		setOptions(config.options);
		// Seed the picker with the saved domain, so a stored choice is visible on a revisit.
		// The list itself only arrives from the account, and asking for it on every visit would
		// contact the provider without being asked; until then a select with no matching option
		// renders empty, which reads as "not set" for a setting that is very much set.
		const saved = config.options.domain;
		if (saved)
			setDomainList((list) => (list.length > 0 ? list : [{ domain: saved, shared: true }]));
	}, [config]);

	const inputWith = useCallback(
		(patch: Partial<SaveAliasInput> = {}): SaveAliasInput => ({
			provider,
			baseUrl: baseUrl.trim() || undefined,
			options,
			apiKey: apiKey.trim() || undefined,
			...patch,
		}),
		[provider, baseUrl, options, apiKey],
	);

	/**
	 * Write the change straight through, as every other settings control does.
	 *
	 * Held back in one case: until a key exists there is nothing to store, and a key belongs to
	 * the provider it was issued by, so a config is never written with one provider's key under
	 * another's name. Both cases keep the change in component state, and it is written the moment
	 * a key for this provider arrives.
	 */
	const persist = useCallback(
		async (patch: Partial<SaveAliasInput>) => {
			const next = inputWith(patch);
			// Never write one provider's key under another's name: a change to a field before a key
			// for the NEW provider exists would otherwise save the old provider's key against it.
			// A provider that authenticates to nobody has no such hazard, and holding it back here
			// meant the catch-all one could never be saved at all.
			const needsKey = describeProvider(next.provider).needsApiKey;
			if (needsKey && !next.apiKey && config?.provider !== next.provider) return;
			// A typed field holding something unusable is not stored. Empty is fine, since that is
			// simply not filled in yet; a domain that cannot work is different, and writing it would
			// arm the generate button on every entry form for a provider that can only fail.
			const unusable = descriptor.fields.some(
				(f) =>
					f.options === "text" &&
					(next.options[f.key] ?? "") !== "" &&
					!looksLikeDomain(next.options[f.key] as string),
			);
			if (unusable) return;
			try {
				await save(next);
			} catch (e) {
				setStatus({ kind: "error", message: messageFor(e) });
			}
		},
		[save, inputWith, config, descriptor],
	);

	const setOption = useCallback(
		(key: string, value: string) => {
			const next = { ...options, [key]: value };
			setOptions(next);
			void persist({ options: next });
		},
		[options, persist],
	);

	/** Verify the key, and load the choices for any field the account has to answer. Read-only on
	 * every provider, so pressing it costs nothing. */
	const onVerify = useCallback(async () => {
		setStatus({ kind: "busy" });
		try {
			const account = await verify(inputWith());
			if (descriptor.fields.some((f) => f.options === "domains")) {
				const d = await domains(inputWith());
				setDomainList(d.options);
				// Preselect the account's own default rather than making someone choose again what
				// they already chose at the provider. Only when nothing is set: an existing choice,
				// including a custom domain, is never overwritten.
				if (d.default && !options.domain) setOption("domain", d.default);
			}
			setStatus({ kind: "ok", account });
		} catch (e) {
			setStatus({ kind: "error", message: messageFor(e) });
		}
	}, [verify, domains, inputWith, descriptor, options.domain, setOption]);

	const onDisconnect = useCallback(async () => {
		await disconnect();
		setApiKey("");
		setOptions({});
		setDomainList([]);
		setStatus({ kind: "idle" });
	}, [disconnect]);

	const busy = status.kind === "busy";
	// Whether the stored key is this provider's. An Addy key is not a SimpleLogin key, so after a
	// switch the saved one is not offered as a thing to keep.
	const savedForThisProvider = config?.provider === provider;
	// Required AND usable: a text field holding something that cannot be a domain is no more
	// configured than an empty one, and saving it would arm a generate button that only fails.
	const missing = descriptor.fields.filter(
		(f) =>
			f.required &&
			(!options[f.key] || (f.options === "text" && !looksLikeDomain(options[f.key] as string))),
	);

	const connected = status.kind === "ok" ? status.account : undefined;
	// Whether the chosen domain is one of the provider's shared ones, which is what decides
	// whether an allowance applies at all. Unknown domain (nothing chosen yet) reads as shared,
	// since that is what a provider default is.
	const selectedIsShared = domainList.find((d) => d.domain === options.domain)?.shared ?? true;

	return (
		<Section icon={<AtSign className="w-4 h-4 text-primary" />} title={t`Alias provider`}>
			<p className="text-xs text-muted-foreground">
				<Trans>
					Generate a different email address for every site, from an account you already have.
					Bramble only asks your provider for an address; it never handles the mail.
				</Trans>
			</p>

			<SelectField
				label={t`Provider`}
				value={provider}
				disabled={busy}
				onChange={(e) => {
					setProvider(e.target.value as AliasProviderId);
					// Options belong to the provider that declared them, so a switch drops them rather
					// than carrying an Addy domain into a SimpleLogin config.
					setOptions({});
					setDomainList([]);
					setStatus({ kind: "idle" });
				}}
			>
				{ALIAS_PROVIDERS.map((p) => (
					<option key={p.id} value={p.id}>
						{p.label}
					</option>
				))}
			</SelectField>

			{descriptor.needsApiKey ? (
				<div>
					<TextField
						label={
							savedForThisProvider ? t`API key (leave blank to keep the saved one)` : t`API key`
						}
						type="password"
						autoComplete="off"
						value={apiKey}
						disabled={busy}
						onChange={(e) => setApiKey(e.target.value)}
						// On blur rather than on change: this is the one field where writing every
						// keystroke would put a series of half-typed keys through the vault key and into
						// storage.
						onBlur={(e) => {
							const key = e.target.value.trim();
							if (key) void persist({ apiKey: key });
						}}
					/>
					<a
						href={descriptor.keyUrl}
						target="_blank"
						rel="noreferrer"
						className="mt-1.5 inline-flex items-center gap-1 text-xs text-primary hover:underline"
					>
						<Trans>Create an API key at {descriptor.label}</Trans>
						<ExternalLink className="w-3 h-3" />
					</a>

					<div className="mt-3 flex flex-wrap items-center gap-2">
						<Button
							variant="secondary"
							size="sm"
							onClick={onVerify}
							disabled={busy}
							className="gap-1.5"
						>
							{busy ? (
								<Loader2 className="w-3.5 h-3.5 animate-spin" />
							) : (
								<RefreshCw className="w-3.5 h-3.5" />
							)}
							<Trans>Check key</Trans>
						</Button>
						{config && (
							<Button
								variant="secondary"
								size="sm"
								onClick={onDisconnect}
								disabled={busy}
								className="gap-1.5 text-muted-foreground"
							>
								<Unplug className="w-3.5 h-3.5" /> <Trans>Disconnect</Trans>
							</Button>
						)}
					</div>

					{connected && (
						<p className="mt-2 text-xs text-primary flex items-center gap-1.5">
							<Check className="w-3.5 h-3.5 shrink-0" />
							{/* The allowance is counted over the provider's shared domains only, so quoting it
						    beside a domain of the user's own would claim a limit that does not apply. */}
							{connected.quota && selectedIsShared
								? t`Connected. ${connected.quota.used} of ${connected.quota.limit} aliases used.`
								: t`Connected.`}
						</p>
					)}
					{status.kind === "error" && (
						// Plain text, deliberately: part of this string can come from the provider.
						<p className="mt-2 text-xs text-destructive">{status.message}</p>
					)}
				</div>
			) : (
				// Nothing to authenticate and nothing to check, so the only control this provider
				// needs is a way to stop using it.
				config && (
					<div>
						<Button
							variant="secondary"
							size="sm"
							onClick={onDisconnect}
							disabled={busy}
							className="gap-1.5 text-muted-foreground"
						>
							<Unplug className="w-3.5 h-3.5" /> <Trans>Disconnect</Trans>
						</Button>
					</div>
				)
			)}

			{descriptor.fields.map((field) => {
				const fromAccount = field.options === "domains";
				const choices: string[] = fromAccount
					? domainList.map((d) => d.domain)
					: [...(field.options as readonly string[])];
				const hint = fieldHint(field.key);
				if (field.options === "text") {
					const value = options[field.key] ?? "";
					// Checked here as well as at generation time. The same guard runs before an alias is
					// made, but discovering a typo on a signup form is far too late: this is the box
					// where it was typed, and the only place it can be fixed.
					const invalid = value.length > 0 && !looksLikeDomain(value);
					return (
						<div key={field.key}>
							<TextField
								label={fieldLabel(field.key)}
								type="text"
								autoComplete="off"
								value={value}
								disabled={busy}
								error={
									invalid
										? t`That does not look like a domain. Enter it on its own, like example.com, with no @ and no https://`
										: undefined
								}
								onChange={(e) => setOption(field.key, e.target.value.trim())}
							/>
							{hint && !invalid && <p className="text-xs text-muted-foreground mt-1.5">{hint}</p>}
						</div>
					);
				}
				return (
					<div key={field.key}>
						<SelectField
							label={fieldLabel(field.key)}
							value={options[field.key] ?? ""}
							disabled={busy || choices.length === 0}
							onChange={(e) => setOption(field.key, e.target.value)}
						>
							{/* An optional field offers "no choice", which is what lets the account's own
							    default apply rather than one we impose. */}
							<option value="">{field.required ? t`Choose...` : t`Provider default`}</option>
							{fromAccount
								? domainList.map((d) => (
										<option key={d.domain} value={d.domain}>
											{/* A domain the user brought is worth marking: it is usually the one
											    with no allowance attached. */}
											{d.shared ? d.domain : t`${d.domain} (your domain)`}
										</option>
									))
								: choices.map((c) => (
										<option key={c} value={c}>
											{c}
										</option>
									))}
						</SelectField>
						{hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
					</div>
				);
			})}

			{/* Only for a provider whose choices come FROM the account. The catch-all one has a
			    domain field too, but it is typed in, so telling someone to check a key they were
			    never asked for is nonsense. */}
			{descriptor.fields.some((f) => f.options === "domains") &&
				missing.length > 0 &&
				domainList.length === 0 && (
					<p className="text-xs text-muted-foreground">
						<Trans>Check the key first, to load the choices this provider needs.</Trans>
					</p>
				)}

			{descriptor.selfHostable && (
				<AdvancedDisclosure>
					<div>
						<TextField
							label={t`Server URL`}
							type="url"
							autoComplete="off"
							value={baseUrl}
							disabled={busy}
							onChange={(e) => {
								setBaseUrl(e.target.value);
								void persist({ baseUrl: e.target.value.trim() || undefined });
							}}
						/>
						<p className="text-xs text-muted-foreground mt-1.5">
							<Trans>
								Only for a self-hosted {descriptor.label}. Leave empty to use the hosted service.
							</Trans>
						</p>
					</div>
				</AdvancedDisclosure>
			)}
		</Section>
	);
}
