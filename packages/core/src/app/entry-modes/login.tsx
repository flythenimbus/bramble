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
import type { LoginEntry, LoginEntryData } from "../../hooks/useVault";
import { parseTotp, totpAt } from "../../util/totp";
import { SelectField } from "../components/ui/select-field";
import { TextArea } from "../components/ui/text-area";
import { TextField } from "../components/ui/text-field";
import { DetailField } from "./DetailField";
import type { EntryDetailBodyProps, EntryFieldsProps, EntryMode } from "./types";

//
export interface LoginFormValues {
	name: string;
	urls: { value: string }[];
	username: string;
	password: string;
	totp: string;
	notes: string;
	autofillEnabled: boolean;
	autoSubmit: boolean;
	subdomainMatch: SubdomainMatchMode;
}

function randomPassword(): string {
	const charset =
		"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?";
	const n = charset.length;
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
	const [showPassword, setShowPassword] = useState(false);
	const {
		fields: urlFields,
		append: appendUrl,
		remove: removeUrl,
	} = useFieldArray({ control, name: "urls" });
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [totpScan, setTotpScan] = useState<"idle" | "scanning" | "error">("idle");
	const [showTotp, setShowTotp] = useState(false);
	const [initialPassword] = useState(() => getValues("password"));

	const passwordValue = watch("password");
	const strength = useMemo(
		() => (passwordValue ? passwordStrength(passwordValue) : null),
		[passwordValue],
	);
	const isBreached = initialBreach?.leaked === true && passwordValue === initialPassword;

	const generatePassword = () => {
		setValue("password", randomPassword(), { shouldDirty: true, shouldValidate: true });
	};

	const scanTotp = async () => {
		setTotpScan("scanning");
		try {
			const decoded = await shell.scanQrFromActiveTab();
			if (decoded && parseTotp(decoded)) {
				setValue("totp", decoded.trim(), { shouldDirty: true });
				setTotpScan("idle");
			} else {
				setTotpScan("error");
			}
		} catch {
			setTotpScan("error");
		}
	};

	const strengthBar = (id: number) =>
		id >= 3 ? "bg-primary" : id === 2 ? "bg-yellow-500" : "bg-destructive";
	const strengthTextColor = (id: number) =>
		id >= 3 ? "text-primary" : id === 2 ? "text-yellow-500" : "text-destructive";

	return (
		<>
			<TextField label="Name" type="text" {...register("name")} />

			<div>
				<div className="flex items-center justify-between mb-2">
					<span className="block text-sm">Websites</span>
					<button
						type="button"
						onClick={() => appendUrl({ value: "" })}
						className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all"
					>
						<Plus className="w-3 h-3" />
						Add URL
					</button>
				</div>

				{urlFields.length > 0 ? (
					<div className="space-y-2">
						{urlFields.map((field, index) => (
							<div key={field.id} className="flex gap-2 items-start">
								<div className="flex-1">
									<TextField
										label="Website URL"
										type="url"
										autoComplete="off"
										{...register(`urls.${index}.value`)}
									/>
								</div>
								<button
									type="button"
									onClick={() => removeUrl(index)}
									className="mt-2 p-2 rounded-lg border border-transparent hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 active:scale-[0.95] transition-all shrink-0"
									aria-label="Remove URL"
								>
									<X className="w-4 h-4" />
								</button>
							</div>
						))}
					</div>
				) : (
					<p className="text-xs text-muted-foreground">
						Add the websites this login covers. Leave empty for a credential not tied to a site.
					</p>
				)}
			</div>

			<TextField
				label="Username or email"
				type="text"
				autoComplete="off"
				{...register("username")}
			/>

			<div>
				<TextField
					label="Password"
					type={showPassword ? "text" : "password"}
					autoComplete="off"
					endAdornment={
						<>
							<button
								type="button"
								onClick={generatePassword}
								className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
								aria-label="Generate password"
							>
								<RefreshCw className="w-3.5 h-3.5" />
							</button>
							<button
								type="button"
								onClick={() => setShowPassword(!showPassword)}
								className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
								aria-label={showPassword ? "Hide password" : "Show password"}
							>
								{showPassword ? (
									<EyeOff className="w-3.5 h-3.5" />
								) : (
									<Eye className="w-3.5 h-3.5" />
								)}
							</button>
						</>
					}
					{...register("password")}
				/>

				{strength && (
					<div className="mt-2.5">
						<div className="flex items-center justify-between mb-1.5">
							<span className="text-xs text-muted-foreground">Password strength</span>
							<span
								className={`text-xs ${
									isBreached ? "text-destructive" : strengthTextColor(strength.id)
								}`}
							>
								{isBreached ? "Breached" : strength.value}
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

				<button
					type="button"
					onClick={generatePassword}
					className="mt-3 flex items-center gap-2 px-3 py-1.5 text-xs rounded-lg border border-primary/50 bg-primary/5 text-primary hover:bg-primary/10 active:scale-[0.98] transition-all"
				>
					<Sparkles className="w-3.5 h-3.5" />
					Generate strong password
				</button>
			</div>

			<div>
				<TextField
					label="Authenticator key (TOTP)"
					type={showTotp ? "text" : "password"}
					autoComplete="off"
					endAdornment={
						<>
							<button
								type="button"
								onClick={scanTotp}
								disabled={totpScan === "scanning"}
								className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all disabled:opacity-50"
								aria-label="Scan QR code from current webpage"
								title="Scan authenticator QR code from current webpage"
							>
								{totpScan === "scanning" ? (
									<Loader2 className="w-3.5 h-3.5 animate-spin" />
								) : (
									<Camera className="w-3.5 h-3.5" />
								)}
							</button>
							<button
								type="button"
								onClick={() => setShowTotp((v) => !v)}
								className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
								aria-label={showTotp ? "Hide authenticator key" : "Show authenticator key"}
							>
								{showTotp ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
							</button>
						</>
					}
					{...register("totp")}
				/>
				<p
					className={`text-xs mt-1.5 ${
						totpScan === "error" ? "text-destructive" : "text-muted-foreground"
					}`}
				>
					{totpScan === "error"
						? "No authenticator QR code found on the page. Make sure it's visible, then retry — or paste the setup key."
						: "Scan the QR on a site's 2FA page, or paste an otpauth:// URI or setup key."}
				</p>
			</div>

			<TextArea label="Notes (optional)" rows={3} {...register("notes")} />

			<div>
				<button
					type="button"
					onClick={() => setAdvancedOpen((o) => !o)}
					className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground active:scale-[0.98] transition-all"
					aria-expanded={advancedOpen}
				>
					{advancedOpen ? (
						<ChevronDown className="w-3.5 h-3.5" />
					) : (
						<ChevronRight className="w-3.5 h-3.5" />
					)}
					Advanced
				</button>
				{advancedOpen && (
					<div className="mt-3 space-y-4 pl-4 border-l border-border/40">
						<ToggleRow
							title="Enable autofill"
							subtitle="Show this entry in the autofill dropdown. When off, it's never auto-filled but stays in your vault."
							checked={watch("autofillEnabled")}
							onChange={(v) => setValue("autofillEnabled", v, { shouldDirty: true })}
						/>
						<ToggleRow
							title="Auto-submit after fill"
							subtitle="Press Enter / submit the form right after the credentials are filled in."
							checked={watch("autoSubmit")}
							onChange={(v) => setValue("autoSubmit", v, { shouldDirty: true })}
						/>
						<div>
							<SelectField label="Subdomain match" {...register("subdomainMatch")}>
								<option value="etld1">eTLD+1 (default — matches all subdomains)</option>
								<option value="exact">Exact hostname only</option>
								<option value="subdomain">This domain and its subdomains</option>
							</SelectField>
							<p className="text-xs text-muted-foreground mt-1.5">
								Controls which URLs this entry will offer credentials for.
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

function TotpField({
	value,
	copied,
	copy,
}: {
	value: string;
	copied: string | null;
	copy: (label: string, value: string) => void;
}) {
	const parsed = useMemo(() => parseTotp(value), [value]);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);

	if (!parsed) {
		return (
			<div className="border-t border-border/40 pt-3 space-y-1.5">
				<p className="text-sm text-muted-foreground">Verification code (TOTP)</p>
				<p className="text-sm text-destructive">
					This authenticator key is invalid and can't generate codes.
				</p>
			</div>
		);
	}

	const { code, secondsRemaining } = totpAt(parsed.totp, now);
	const matched = copied === "totp";

	return (
		<div className="border-t border-border/40 pt-3 space-y-2">
			<p className="text-sm text-muted-foreground">Verification code (TOTP)</p>
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
					<button
						type="button"
						onClick={() => copy("totp", code)}
						className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
						aria-label="Copy verification code"
					>
						{matched ? <Check className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4" />}
					</button>
				</div>
			</div>
		</div>
	);
}

function CountdownRing({ remaining, period }: { remaining: number; period: number }) {
	const radius = 11;
	const circumference = 2 * Math.PI * radius;
	const fraction = Math.max(0, Math.min(1, remaining / period));
	const low = remaining <= 5;
	return (
		<div className="relative flex items-center justify-center w-7 h-7" title={`${remaining}s left`}>
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

function LoginDetail({ entry, copied, copy }: EntryDetailBodyProps) {
	const login = entry as LoginEntry;
	const [showPassword, setShowPassword] = useState(false);

	return (
		<>
			{login.urls.map((url, i) => {
				const copyName = login.urls.length === 1 ? "website" : `website-${i}`;
				return (
					<DetailField
						// biome-ignore lint/suspicious/noArrayIndexKey: index needed to disambiguate accidentally-duplicate URLs
						key={`${url}-${i}`}
						label="Website"
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
				label="Username"
				copied={copied}
				copyName="username"
				onCopy={() => copy("username", login.username)}
			>
				<span className="text-sm truncate">{login.username || "—"}</span>
			</DetailField>

			<DetailField
				label="Password"
				copied={copied}
				copyName="password"
				onCopy={() => copy("password", login.password)}
				extraAction={
					<button
						type="button"
						onClick={() => setShowPassword((v) => !v)}
						className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
						aria-label={showPassword ? "Hide password" : "Show password"}
					>
						{showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
					</button>
				}
			>
				<span className="text-sm font-mono truncate">
					{showPassword ? login.password : "•".repeat(Math.min(login.password.length, 16))}
				</span>
			</DetailField>

			{login.totp && <TotpField value={login.totp} copied={copied} copy={copy} />}

			{login.notes && (
				<div className="space-y-1.5">
					<p className="text-xs text-muted-foreground">Notes</p>
					<p className="text-sm whitespace-pre-wrap">{login.notes}</p>
				</div>
			)}
		</>
	);
}

export const loginMode: EntryMode = {
	type: "login",
	label: "Login",
	description: "Add a new login",
	icon: Globe,

	emptyForm: ({ defaultUrl }) => ({
		name: "",
		urls: defaultUrl ? [{ value: defaultUrl }] : [],
		username: "",
		password: "",
		totp: "",
		notes: "",
		customFields: [],
		autofillEnabled: true,
		autoSubmit: false,
		subdomainMatch: "etld1",
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
		};
	},

	toEntry: (values) => {
		const v = values as LoginFormValues;
		const urls = v.urls.map((u) => u.value.trim()).filter((u) => u.length > 0);
		return {
			type: "login",
			name: v.name,
			urls,
			username: v.username,
			password: v.password,
			totp: v.totp.trim() || undefined,
			notes: v.notes || undefined,
			autofillEnabled: v.autofillEnabled ? undefined : false,
			autoSubmit: v.autoSubmit ? true : undefined,
			subdomainMatch: v.subdomainMatch === "etld1" ? undefined : v.subdomainMatch,
		};
	},

	Fields: LoginFields,
	Detail: LoginDetail,

	detailSubtitle: (entry) => (entry as LoginEntry).urls[0] || undefined,

	detailAlert: (entry) =>
		(entry as LoginEntry).breach?.leaked === true
			? {
					title: "This password appeared in a known data breach.",
					body: "Change it on the site to keep your account safe.",
				}
			: null,

	row: (entry) => {
		const login = entry as LoginEntry;
		return {
			icon: Globe,
			initials: login.name.substring(0, 2).toUpperCase(),
			secondary: login.username,
			copyItems: [
				{ label: "username", value: login.username },
				{ label: "password", value: login.password },
			],
			leaked: login.breach?.leaked === true,
		};
	},

	searchText: (entry) => {
		const login = entry as LoginEntry;
		return `${login.name} ${login.username} ${login.urls.join(" ")}`.toLowerCase();
	},
};
