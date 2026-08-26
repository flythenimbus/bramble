import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { passwordStrength } from "check-password-strength";
import {
	Camera,
	Check,
	ChevronDown,
	ChevronRight,
	Copy,
	Eye,
	EyeOff,
	Globe,
	History,
	KeyRound,
	Loader2,
	Plus,
	RefreshCw,
	Sparkles,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useFieldArray, useFormContext } from "react-hook-form";
import type { SubdomainMatchMode } from "../../adapters/autofill";
import { usePlatform } from "../../context/PlatformContext";
import type {
	LoginEntry,
	LoginEntryData,
	PasskeyCredential,
	PasswordChange,
} from "../../hooks/useVault";
import { formatDate, formatDateTimeExact } from "../../util/format-date";
import { classifyScannedQr, parseTotp, type QrScanFailure, totpAt } from "../../util/totp";
import { Button } from "../components/ui/button";
import { SelectField } from "../components/ui/select-field";
import { TextArea } from "../components/ui/text-area";
import { TextField } from "../components/ui/text-field";
import { DetailField, DetailValue } from "./DetailField";
import type { EntryDetailBodyProps, EntryFieldsProps, EntryMode } from "./types";

/** The login form's value shape. (Custom fields are host-owned and shared across modes, so not listed here.) */
interface LoginFormValues {
	name: string;
	/** Wrapped as `{ value }[]` so useFieldArray has stable per-row identity; `toEntry` collapses back to `string[]`. */
	urls: { value: string }[];
	username: string;
	password: string;
	/** Authenticator key: an `otpauth://` URI or bare base32 setup key, stored verbatim. Empty string means no 2FA. */
	totp: string;
	notes: string;
	autofillEnabled: boolean;
	autoSubmit: boolean;
	subdomainMatch: SubdomainMatchMode;
	/** Hosted passkeys; carried through the form (not edited here, only removed) so a
	 * save never drops them. Minted by the provider, not added from this form. */
	passkeys: PasskeyCredential[];
}

/** QR-scan state. `failed` carries why, so the hint can say what actually happened. */
type TotpScanState =
	| { kind: "idle" }
	| { kind: "scanning" }
	| { kind: "failed"; failure: QrScanFailure; vendor?: string };

/** Generate a 16-char password by unbiased rejection sampling over the charset. */
function randomPassword(): string {
	const charset =
		"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?";
	const n = charset.length;
	// 88 doesn't divide 256, so byte % n would bias; only accept bytes < floor(256/n)*n.
	const limit = Math.floor(256 / n) * n;
	const out: string[] = [];
	const buf = new Uint8Array(16);
	while (out.length < 16) {
		crypto.getRandomValues(buf);
		for (let i = 0; i < buf.length && out.length < 16; i++) {
			const b = buf[i]!;
			if (b < limit) out.push(charset.charAt(b % n));
		}
	}
	return out.join("");
}

function LoginFields({ initialBreach }: EntryFieldsProps) {
	const { register, control, watch, setValue, getValues } = useFormContext<LoginFormValues>();
	const { shell } = usePlatform();
	const { t } = useLingui();
	const [showPassword, setShowPassword] = useState(false);
	const {
		fields: urlFields,
		append: appendUrl,
		remove: removeUrl,
	} = useFieldArray({ control, name: "urls" });
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [totpScan, setTotpScan] = useState<TotpScanState>({ kind: "idle" });
	const [showTotp, setShowTotp] = useState(false);
	// Password at mount, so the cached breach flag only applies while the user hasn't edited it.
	const [initialPassword] = useState(() => getValues("password"));

	const passkeys = watch("passkeys") ?? [];
	const removePasskey = (credentialId: string) =>
		setValue(
			"passkeys",
			passkeys.filter((p) => p.credentialId !== credentialId),
			{ shouldDirty: true },
		);

	const passwordValue = watch("password");
	const strength = useMemo(
		() => (passwordValue ? passwordStrength(passwordValue) : null),
		[passwordValue],
	);
	const isBreached = initialBreach?.leaked === true && passwordValue === initialPassword;

	const generatePassword = () => {
		setValue("password", randomPassword(), { shouldDirty: true, shouldValidate: true });
	};

	// Accept a scanned QR only if it parses as a usable TOTP, so a stray QR can't land a junk key.
	const scanTotp = async () => {
		setTotpScan({ kind: "scanning" });
		try {
			const { uri, failure, vendor } = classifyScannedQr(await shell.scanQrFromActiveTab());
			if (uri) {
				setValue("totp", uri, { shouldDirty: true });
				setTotpScan({ kind: "idle" });
			} else {
				setTotpScan({ kind: "failed", failure: failure ?? "not-totp", vendor });
			}
		} catch {
			setTotpScan({ kind: "failed", failure: "not-found" });
		}
	};

	const scanHint = () => {
		if (totpScan.kind !== "failed") {
			return t`Scan the QR on a site's 2FA page, or paste an otpauth:// URI or setup key.`;
		}
		switch (totpScan.failure) {
			case "vendor-app":
				// The whole point of naming the app: the way out is a link the site
				// hides behind "Can't scan?" or similar, and nobody finds it by guessing.
				return t`That QR sets up ${totpScan.vendor ?? "another authenticator app"}, so it holds no key to save. On the site, choose to use a different authenticator app, then scan the code it offers.`;
			case "migration":
				return t`That QR is an authenticator export holding several accounts, not a setup code. Add each account from its own site instead.`;
			case "not-totp":
				return t`A QR code was found, but it isn't an authenticator setup code. Open the site's 2FA page, or paste the setup key.`;
			default:
				return t`No QR code found on the page. Make sure it's visible, then retry, or paste the setup key.`;
		}
	};

	const strengthBar = (id: number) =>
		id >= 3 ? "bg-primary" : id === 2 ? "bg-yellow-500" : "bg-destructive";
	const strengthTextColor = (id: number) =>
		id >= 3 ? "text-primary" : id === 2 ? "text-yellow-500" : "text-destructive";

	return (
		<>
			<TextField label={t`Name`} type="text" {...register("name")} />

			<div>
				<div className="flex items-center justify-between mb-2">
					<span className="block text-sm">
						<Trans>Websites</Trans>
					</span>
					<Button
						variant="secondary"
						size="none"
						onClick={() => appendUrl({ value: "" })}
						className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md"
					>
						<Plus className="w-3 h-3" />
						<Trans>Add URL</Trans>
					</Button>
				</div>

				{urlFields.length > 0 ? (
					<div className="space-y-2">
						{urlFields.map((field, index) => (
							<div key={field.id} className="flex gap-2 items-start">
								<div className="flex-1">
									<TextField
										label={t`Website URL`}
										type="url"
										autoComplete="off"
										{...register(`urls.${index}.value`)}
									/>
								</div>
								<Button
									variant="ghost"
									size="icon"
									onClick={() => removeUrl(index)}
									className="mt-2 shrink-0 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30"
									aria-label={t`Remove URL`}
								>
									<X className="w-4 h-4" />
								</Button>
							</div>
						))}
					</div>
				) : (
					<p className="text-xs text-muted-foreground">
						<Trans>
							Add the websites this login covers. Leave empty for a credential not tied to a site.
						</Trans>
					</p>
				)}
			</div>

			{/* The credential itself. Without a heading of their own these read as
			    children of the Websites group above: a headed group visually claims
			    everything under it until the next heading. */}
			<div>
				<span className="block text-sm mb-2">
					<Trans>Details</Trans>
				</span>
				<div className="space-y-3">
					<TextField
						label={t`Username or email`}
						type="text"
						autoComplete="off"
						{...register("username")}
					/>

					<div>
						<TextField
							label={t`Password`}
							type={showPassword ? "text" : "password"}
							autoComplete="off"
							endAdornment={
								<>
									<Button
										variant="ghost"
										size="none"
										onClick={generatePassword}
										className="p-1.5 rounded-md"
										aria-label={t`Generate password`}
									>
										<RefreshCw className="w-3.5 h-3.5" />
									</Button>
									<Button
										variant="ghost"
										size="none"
										onClick={() => setShowPassword(!showPassword)}
										className="p-1.5 rounded-md"
										aria-label={showPassword ? t`Hide password` : t`Show password`}
									>
										{showPassword ? (
											<EyeOff className="w-3.5 h-3.5" />
										) : (
											<Eye className="w-3.5 h-3.5" />
										)}
									</Button>
								</>
							}
							{...register("password")}
						/>

						{strength && (
							<div className="mt-2.5">
								<div className="flex items-center justify-between mb-1.5">
									<span className="text-xs text-muted-foreground">
										<Trans>Password strength</Trans>
									</span>
									<span
										className={`text-xs ${
											isBreached ? "text-destructive" : strengthTextColor(strength.id)
										}`}
									>
										{isBreached ? t`Breached` : strength.value}
									</span>
								</div>
								<div className="h-1.5 bg-muted rounded-full overflow-hidden">
									<div
										className={`h-full transition-all duration-300 ${
											isBreached ? "bg-destructive" : strengthBar(strength.id)
										}`}
										style={{
											width: isBreached ? "5%" : `${((strength.id + 1) / 4) * 100}%`,
										}}
									/>
								</div>
							</div>
						)}

						<Button
							variant="secondary"
							size="none"
							onClick={generatePassword}
							className="mt-3 flex items-center gap-2 px-3 py-1.5 text-xs border-primary/50 bg-primary/5 text-primary hover:bg-primary/10"
						>
							<Sparkles className="w-3.5 h-3.5" />
							<Trans>Generate strong password</Trans>
						</Button>
					</div>

					<div>
						<TextField
							label={t`Authenticator key (TOTP)`}
							type={showTotp ? "text" : "password"}
							autoComplete="off"
							endAdornment={
								<>
									<Button
										variant="ghost"
										size="none"
										onClick={scanTotp}
										disabled={totpScan.kind === "scanning"}
										className="p-1.5 rounded-md"
										aria-label={t`Scan QR code from current webpage`}
										title={t`Scan authenticator QR code from current webpage`}
									>
										{totpScan.kind === "scanning" ? (
											<Loader2 className="w-3.5 h-3.5 animate-spin" />
										) : (
											<Camera className="w-3.5 h-3.5" />
										)}
									</Button>
									<Button
										variant="ghost"
										size="none"
										onClick={() => setShowTotp((v) => !v)}
										className="p-1.5 rounded-md"
										aria-label={showTotp ? t`Hide authenticator key` : t`Show authenticator key`}
									>
										{showTotp ? (
											<EyeOff className="w-3.5 h-3.5" />
										) : (
											<Eye className="w-3.5 h-3.5" />
										)}
									</Button>
								</>
							}
							{...register("totp")}
						/>
						<p
							className={`text-xs mt-1.5 ${
								totpScan.kind === "failed" ? "text-destructive" : "text-muted-foreground"
							}`}
						>
							{scanHint()}
						</p>
					</div>
				</div>
			</div>

			{passkeys.length > 0 && (
				<div>
					<span className="block text-sm mb-2">
						<Trans>Passkeys</Trans>
					</span>
					<div className="space-y-2">
						{passkeys.map((pk) => (
							<div
								key={pk.credentialId}
								className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-border bg-muted/30"
							>
								<KeyRound className="w-4 h-4 text-primary shrink-0" />
								<div className="min-w-0 flex-1">
									<div className="text-sm truncate">
										{pk.userName || pk.userDisplayName || pk.rpId}
									</div>
									<div className="text-xs text-muted-foreground truncate">
										{pk.rpId}
										{pk.createdAt ? ` · ${formatDate(pk.createdAt)}` : ""}
									</div>
								</div>
								<Button
									variant="ghost"
									size="icon"
									onClick={() => removePasskey(pk.credentialId)}
									className="shrink-0 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30"
									aria-label={t`Remove passkey`}
								>
									<X className="w-4 h-4" />
								</Button>
							</div>
						))}
					</div>
					<p className="text-xs text-muted-foreground mt-1.5">
						<Trans>Added when you create a passkey on a site with Bramble. Remove to delete.</Trans>
					</p>
				</div>
			)}

			<TextArea label={t`Notes (optional)`} rows={3} {...register("notes")} />

			<div>
				<Button
					variant="link"
					size="none"
					onClick={() => setAdvancedOpen((o) => !o)}
					className="flex items-center gap-1.5 text-xs active:scale-[0.98]"
					aria-expanded={advancedOpen}
				>
					{advancedOpen ? (
						<ChevronDown className="w-3.5 h-3.5" />
					) : (
						<ChevronRight className="w-3.5 h-3.5" />
					)}
					<Trans>Advanced</Trans>
				</Button>
				{advancedOpen && (
					<div className="mt-3 space-y-4 pl-4 border-l border-border/40">
						<ToggleRow
							title={t`Enable autofill`}
							subtitle={t`Show this entry in the autofill dropdown. When off, it's never auto-filled but stays in your vault.`}
							checked={watch("autofillEnabled")}
							onChange={(v) => setValue("autofillEnabled", v, { shouldDirty: true })}
						/>
						<ToggleRow
							title={t`Auto-submit after fill`}
							subtitle={t`Press Enter / submit the form right after the credentials are filled in.`}
							checked={watch("autoSubmit")}
							onChange={(v) => setValue("autoSubmit", v, { shouldDirty: true })}
						/>
						<div>
							<SelectField label={t`Subdomain match`} {...register("subdomainMatch")}>
								<option value="etld1">{t`eTLD+1 (default, matches all subdomains)`}</option>
								<option value="exact">{t`Exact hostname only`}</option>
								<option value="subdomain">{t`This domain and its subdomains`}</option>
							</SelectField>
							<p className="text-xs text-muted-foreground mt-1.5">
								<Trans>Controls which URLs this entry will offer credentials for.</Trans>
							</p>
						</div>
					</div>
				)}
			</div>
		</>
	);
}

interface ToggleRowProps {
	title: string;
	subtitle: string;
	checked: boolean;
	onChange: (next: boolean) => void;
}

function ToggleRow({ title, subtitle, checked, onChange }: ToggleRowProps) {
	return (
		<div className="flex items-start justify-between gap-3">
			<div className="min-w-0">
				<p className="text-sm">{title}</p>
				<p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
			</div>
			<button
				type="button"
				onClick={() => onChange(!checked)}
				aria-pressed={checked}
				className={`relative shrink-0 w-11 h-6 rounded-full border transition-all ${
					checked ? "bg-primary border-primary/20" : "bg-muted border-border"
				}`}
			>
				<span
					className={`absolute top-0.5 w-5 h-5 rounded-full bg-card shadow-sm transition-all ${
						checked ? "left-5 dark:bg-primary-foreground" : "left-0.5 dark:bg-card-foreground"
					}`}
				/>
			</button>
		</div>
	);
}

/** Live two-factor code for an entry's authenticator key, recomputed every second with a countdown ring. */
function TotpField({
	value,
	copied,
	copy,
}: {
	value: string;
	copied: string | null;
	copy: (label: string, value: string) => void;
}) {
	const { t } = useLingui();
	const parsed = useMemo(() => parseTotp(value), [value]);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);

	if (!parsed) {
		return (
			<div className="border-t border-border/40 pt-3 space-y-1.5">
				<p className="text-sm text-muted-foreground">
					<Trans>Verification code (TOTP)</Trans>
				</p>
				<p className="text-sm text-destructive">
					<Trans>This authenticator key is invalid and can't generate codes.</Trans>
				</p>
			</div>
		);
	}

	const { code, secondsRemaining } = totpAt(parsed.totp, now);
	const matched = copied === "totp";

	return (
		<div className="border-t border-border/40 pt-3 space-y-2">
			<p className="text-sm text-muted-foreground">
				<Trans>Verification code (TOTP)</Trans>
			</p>
			<div className="flex items-center justify-between gap-3">
				<div className="flex items-baseline gap-3 font-mono text-2xl tracking-wider tabular-nums">
					{code.length === 6 ? (
						<>
							<span>{code.slice(0, 3)}</span>
							<span>{code.slice(3)}</span>
						</>
					) : (
						<span>{code}</span>
					)}
				</div>
				<div className="flex items-center gap-3">
					<CountdownRing remaining={secondsRemaining} period={parsed.totp.period} />
					<Button
						variant="ghost"
						size="none"
						onClick={() => copy("totp", code)}
						className="p-1.5 rounded-md"
						aria-label={t`Copy verification code`}
					>
						{matched ? <Check className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4" />}
					</Button>
				</div>
			</div>
		</div>
	);
}

/** Ring + number that drains as the current code ages out, turning red in the final few seconds. */
function CountdownRing({ remaining, period }: { remaining: number; period: number }) {
	const { t } = useLingui();
	const radius = 11;
	const circumference = 2 * Math.PI * radius;
	const fraction = Math.max(0, Math.min(1, remaining / period));
	const low = remaining <= 5;
	return (
		<div
			className="relative flex items-center justify-center w-7 h-7"
			title={t`${remaining}s left`}
		>
			<svg width="28" height="28" viewBox="0 0 28 28" className="-rotate-90" aria-hidden="true">
				<circle cx="14" cy="14" r={radius} fill="none" strokeWidth="2" className="stroke-muted" />
				<circle
					cx="14"
					cy="14"
					r={radius}
					fill="none"
					strokeWidth="2"
					strokeLinecap="round"
					strokeDasharray={circumference}
					strokeDashoffset={circumference * (1 - fraction)}
					className={low ? "stroke-destructive" : "stroke-foreground"}
					style={{ transition: "stroke-dashoffset 1s linear" }}
				/>
			</svg>
			<span
				className={`absolute text-[10px] tabular-nums ${
					low ? "text-destructive" : "text-muted-foreground"
				}`}
			>
				{remaining}
			</span>
		</div>
	);
}

/**
 * Superseded passwords, newest first. Collapsed it is a one-line footnote saying when
 * the password last changed; expanded each row reveals and copies the old value, which
 * is what gets you back in while a slow IdP still expects it.
 */
function PasswordChangelogField({
	changelog,
	copied,
	copy,
}: {
	changelog: PasswordChange[];
	copied: string | null;
	copy: (label: string, value: string) => void;
}) {
	const { t } = useLingui();
	const [open, setOpen] = useState(false);
	const [revealed, setRevealed] = useState<ReadonlySet<number>>(new Set());

	const toggleReveal = (i: number) => {
		setRevealed((prev) => {
			const next = new Set(prev);
			if (!next.delete(i)) next.add(i);
			return next;
		});
	};

	// Non-empty by construction: the caller renders this only when there is a row.
	const lastChangedAt = changelog[0]!.changedAt;

	return (
		<div className="space-y-1.5">
			{/* `link` keeps the cva base's inline-flex, so the row hugs its text instead of
			    stretching and centring the way a block-level flex button would. */}
			<Button
				variant="link"
				size="none"
				onClick={() => setOpen((v) => !v)}
				className="gap-1.5 text-xs"
				aria-expanded={open}
			>
				{open ? (
					<ChevronDown className="w-3 h-3 shrink-0" />
				) : (
					<ChevronRight className="w-3 h-3 shrink-0" />
				)}
				<History className="w-3 h-3 shrink-0" />
				<span className="truncate">
					{t`Password changed ${formatDateTimeExact(lastChangedAt)}`}
				</span>
			</Button>

			{open && (
				<div className="space-y-1.5">
					{changelog.map((change, i) => {
						const copyName = `password-changelog-${i}`;
						const isRevealed = revealed.has(i);
						return (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: two rotations can share a timestamp; position disambiguates
								key={`${change.changedAt}-${i}`}
								className="flex items-center gap-2 px-3 py-2 rounded-md border border-border/50 bg-muted/20"
							>
								<div className="flex-1 min-w-0">
									<DetailValue mono wrap={isRevealed}>
										{isRevealed ? change.value : "•".repeat(Math.min(change.value.length, 16))}
									</DetailValue>
									<span className="block text-[10px] text-muted-foreground tabular-nums">
										{t`Replaced ${formatDateTimeExact(change.changedAt)}`}
									</span>
								</div>
								<Button
									variant="ghost"
									size="none"
									onClick={() => toggleReveal(i)}
									className="p-1.5 rounded-md"
									aria-label={isRevealed ? t`Hide previous password` : t`Show previous password`}
								>
									{isRevealed ? (
										<EyeOff className="w-3.5 h-3.5" />
									) : (
										<Eye className="w-3.5 h-3.5" />
									)}
								</Button>
								<Button
									variant="ghost"
									size="none"
									onClick={() => copy(copyName, change.value)}
									className="p-1.5 rounded-md"
									aria-label={t`Copy previous password`}
								>
									{copied === copyName ? (
										<Check className="w-3.5 h-3.5 text-primary" />
									) : (
										<Copy className="w-3.5 h-3.5" />
									)}
								</Button>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

function LoginDetail({ entry, copied, copy }: EntryDetailBodyProps) {
	const login = entry as LoginEntry;
	const { t } = useLingui();
	const [showPassword, setShowPassword] = useState(false);

	return (
		<>
			{login.urls.map((url, i) => {
				// Key combines URL with position so intentional duplicates (e.g. http vs https) don't collide.
				const copyName = login.urls.length === 1 ? "website" : `website-${i}`;
				return (
					<DetailField
						// biome-ignore lint/suspicious/noArrayIndexKey: index needed to disambiguate accidentally-duplicate URLs
						key={`${url}-${i}`}
						label={t`Website`}
						copied={copied}
						copyName={copyName}
						onCopy={() => copy(copyName, url)}
					>
						<div className="flex items-center gap-2 text-sm">
							<Globe className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
							<span className="truncate">{url}</span>
						</div>
					</DetailField>
				);
			})}

			<DetailField
				label={t`Username`}
				copied={copied}
				copyName="username"
				onCopy={() => copy("username", login.username)}
			>
				<DetailValue>{login.username || "-"}</DetailValue>
			</DetailField>

			<DetailField
				label={t`Password`}
				copied={copied}
				copyName="password"
				onCopy={() => copy("password", login.password)}
				extraAction={
					<Button
						variant="ghost"
						size="none"
						onClick={() => setShowPassword((v) => !v)}
						className="p-1.5 rounded-md"
						aria-label={showPassword ? t`Hide password` : t`Show password`}
					>
						{showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
					</Button>
				}
			>
				<DetailValue mono wrap={showPassword}>
					{showPassword ? login.password : "•".repeat(Math.min(login.password.length, 16))}
				</DetailValue>
			</DetailField>

			{login.passwordChangelog && login.passwordChangelog.length > 0 && (
				<PasswordChangelogField changelog={login.passwordChangelog} copied={copied} copy={copy} />
			)}

			{login.totp && <TotpField value={login.totp} copied={copied} copy={copy} />}

			{login.passkeys && login.passkeys.length > 0 && (
				<div className="space-y-1.5">
					<p className="text-xs text-muted-foreground">
						<Trans>Passkeys</Trans>
					</p>
					<div className="flex flex-wrap gap-1.5">
						{login.passkeys.map((pk) => (
							<span
								key={pk.credentialId}
								className="inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded-md bg-primary/10 text-primary border border-primary/20"
								title={t`This login has a passkey`}
							>
								<KeyRound className="w-3 h-3" />
								{pk.userName || pk.userDisplayName || pk.rpId}
							</span>
						))}
					</div>
				</div>
			)}

			{login.notes && (
				<div className="space-y-1.5">
					<p className="text-xs text-muted-foreground">
						<Trans>Notes</Trans>
					</p>
					<p className="text-sm whitespace-pre-wrap">{login.notes}</p>
				</div>
			)}
		</>
	);
}

export const loginMode: EntryMode = {
	type: "login",
	get label() {
		return i18n._(msg`Login`);
	},
	get description() {
		return i18n._(msg`Add a new login`);
	},
	icon: Globe,

	emptyForm: ({ defaultUrl }) => ({
		name: "",
		// Seed with the active tab's URL when launched from a page, else start empty.
		urls: defaultUrl ? [{ value: defaultUrl }] : [],
		username: "",
		password: "",
		totp: "",
		notes: "",
		customFields: [],
		autofillEnabled: true,
		autoSubmit: false,
		subdomainMatch: "etld1",
		passkeys: [],
	}),

	toForm: (entry) => {
		const login = entry as LoginEntryData;
		return {
			name: login.name,
			urls: login.urls.map((value) => ({ value })),
			username: login.username,
			password: login.password,
			totp: login.totp ?? "",
			notes: login.notes ?? "",
			autofillEnabled: login.autofillEnabled !== false,
			autoSubmit: login.autoSubmit === true,
			subdomainMatch: login.subdomainMatch ?? "etld1",
			passkeys: login.passkeys ?? [],
		};
	},

	toEntry: (values) => {
		const v = values as LoginFormValues;
		// Drop blank rows so an empty input doesn't pollute the persisted list or knownHostnames.
		const urls = v.urls.map((u) => u.value.trim()).filter((u) => u.length > 0);
		return {
			type: "login",
			name: v.name,
			urls,
			username: v.username,
			password: v.password,
			totp: v.totp.trim() || undefined,
			notes: v.notes || undefined,
			// Persist only overrides that differ from defaults, keeping the encrypted payload minimal.
			autofillEnabled: v.autofillEnabled ? undefined : false,
			autoSubmit: v.autoSubmit ? true : undefined,
			subdomainMatch: v.subdomainMatch === "etld1" ? undefined : v.subdomainMatch,
			// Carried through untouched (the form only removes); omit when empty.
			passkeys: v.passkeys?.length ? v.passkeys : undefined,
		};
	},

	Fields: LoginFields,
	Detail: LoginDetail,

	detailSubtitle: (entry) => (entry as LoginEntry).urls[0] || undefined,

	detailAlert: (entry) =>
		(entry as LoginEntry).breach?.leaked === true
			? {
					title: i18n._(msg`This password appeared in a known data breach.`),
					body: i18n._(msg`Change it on the site to keep your account safe.`),
				}
			: null,

	row: (entry) => {
		const login = entry as LoginEntry;
		// Offered only when the stored key actually parses: an unparseable one can't generate a
		// code, and the detail view already says so. A thunk, so the code is generated on click
		// rather than baked into a row projection that outlives its 30-second step.
		const parsedTotp = parseTotp(login.totp);
		return {
			icon: Globe,
			initials: login.name.substring(0, 2).toUpperCase(),
			secondary: login.username,
			copyItems: [
				{ label: i18n._(msg`username`), value: login.username },
				{ label: i18n._(msg`password`), value: login.password },
				...(parsedTotp
					? [
							{
								label: i18n._(msg`verification code`),
								value: () => totpAt(parsedTotp.totp).code,
							},
						]
					: []),
			],
			leaked: login.breach?.leaked === true,
			passkeys: login.passkeys?.length ?? 0,
		};
	},

	searchText: (entry) => {
		const login = entry as LoginEntry;
		// Include every URL so search hits on any covered site, not just the first.
		return `${login.name} ${login.username} ${login.urls.join(" ")}`.toLowerCase();
	},
};
