import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Check, Copy, Eye, EyeOff, KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useFormContext } from "react-hook-form";
import type { SshKeyEntry, SshKeyEntryData } from "../../hooks/useVault";
import { deriveKeyType, sshFingerprint } from "../../util/ssh";
import { Button } from "../components/ui/button";
import { SecretArea } from "../components/ui/secret-area";
import { TextArea } from "../components/ui/text-area";
import { TextField } from "../components/ui/text-field";
import { DetailField, DetailValue } from "./DetailField";
import type { EntryDetailBodyProps, EntryMode } from "./types";

/** OpenSSH SHA-256 fingerprint of `publicKey`. undefined until derived (async) and on parse failure. */
function useSshFingerprint(publicKey: string): string | undefined {
	const [fingerprint, setFingerprint] = useState<string | undefined>(undefined);
	useEffect(() => {
		let cancelled = false;
		setFingerprint(undefined);
		if (!publicKey) return;
		void sshFingerprint(publicKey).then((fp) => {
			if (!cancelled) setFingerprint(fp);
		});
		return () => {
			cancelled = true;
		};
	}, [publicKey]);
	return fingerprint;
}

interface SshKeyFormValues {
	name: string;
	publicKey: string;
	privateKey: string;
	passphrase: string;
	notes: string;
}

function SshKeyFields() {
	const { register } = useFormContext<SshKeyFormValues>();
	const { t } = useLingui();
	const [showPassphrase, setShowPassphrase] = useState(false);

	return (
		<>
			<TextField label={t`Name`} type="text" {...register("name")} />
			<TextArea label={t`Public key`} rows={2} className="font-mono" {...register("publicKey")} />
			<SecretArea label={t`Private key`} rows={6} autoComplete="off" {...register("privateKey")} />
			<TextField
				label={t`Passphrase (optional)`}
				type={showPassphrase ? "text" : "password"}
				autoComplete="off"
				endAdornment={
					<Button
						variant="ghost"
						size="none"
						onClick={() => setShowPassphrase((v) => !v)}
						className="p-1.5 rounded-md"
						aria-label={showPassphrase ? t`Hide passphrase` : t`Show passphrase`}
					>
						{showPassphrase ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
					</Button>
				}
				{...register("passphrase")}
			/>
			<TextArea label={t`Notes (optional)`} rows={2} {...register("notes")} />
		</>
	);
}

interface KeyBlockProps {
	label: string;
	value: string;
	copyName: string;
	copied: string | null;
	onCopy: () => void;
	/** Secret blocks start masked with a reveal toggle; public ones are shown. */
	secret?: boolean;
}

/** Multi-line key display with copy and (for secrets) reveal controls. */
function KeyBlock({ label, value, copyName, copied, onCopy, secret }: KeyBlockProps) {
	const { t } = useLingui();
	const [revealed, setRevealed] = useState(false);
	const masked = secret && !revealed;
	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between">
				<p className="text-xs text-muted-foreground">{label}</p>
				<div className="flex items-center gap-1">
					{secret && (
						<Button
							variant="ghost"
							size="none"
							onClick={() => setRevealed((v) => !v)}
							className="p-1.5 rounded-md"
							aria-label={revealed ? t`Hide private key` : t`Show private key`}
						>
							{revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
						</Button>
					)}
					<Button
						variant="ghost"
						size="none"
						onClick={onCopy}
						className="p-1.5 rounded-md"
						aria-label={t`Copy ${label.toLowerCase()}`}
					>
						{copied === copyName ? (
							<Check className="w-3.5 h-3.5 text-primary" />
						) : (
							<Copy className="w-3.5 h-3.5" />
						)}
					</Button>
				</div>
			</div>
			<pre className="text-xs font-mono whitespace-pre-wrap break-all rounded-md border border-border/50 p-3 max-h-48 overflow-auto">
				{masked ? "•".repeat(48) : value || "-"}
			</pre>
		</div>
	);
}

function SshKeyDetail({ entry, copied, copy }: EntryDetailBodyProps) {
	const key = entry as SshKeyEntry;
	const { t } = useLingui();
	const [showPassphrase, setShowPassphrase] = useState(false);
	const fingerprint = useSshFingerprint(key.publicKey);
	return (
		<>
			{fingerprint && (
				<DetailField
					label={t`Fingerprint`}
					copied={copied}
					copyName="fingerprint"
					onCopy={() => copy("fingerprint", fingerprint)}
				>
					<DetailValue mono>{fingerprint}</DetailValue>
				</DetailField>
			)}

			{key.publicKey && (
				<KeyBlock
					label={t`Public key`}
					value={key.publicKey}
					copyName="public key"
					copied={copied}
					onCopy={() => copy("public key", key.publicKey)}
				/>
			)}

			<KeyBlock
				label={t`Private key`}
				value={key.privateKey}
				copyName="private key"
				copied={copied}
				onCopy={() => copy("private key", key.privateKey)}
				secret
			/>

			{key.passphrase && (
				<DetailField
					label={t`Passphrase`}
					copied={copied}
					copyName="passphrase"
					onCopy={() => copy("passphrase", key.passphrase ?? "")}
					extraAction={
						<Button
							variant="ghost"
							size="none"
							onClick={() => setShowPassphrase((v) => !v)}
							className="p-1.5 rounded-md"
							aria-label={showPassphrase ? t`Hide passphrase` : t`Show passphrase`}
						>
							{showPassphrase ? (
								<EyeOff className="w-3.5 h-3.5" />
							) : (
								<Eye className="w-3.5 h-3.5" />
							)}
						</Button>
					}
				>
					<DetailValue mono wrap={showPassphrase}>
						{showPassphrase ? key.passphrase : "•".repeat(Math.min(key.passphrase.length, 16))}
					</DetailValue>
				</DetailField>
			)}

			{key.notes && (
				<div className="space-y-1.5">
					<p className="text-xs text-muted-foreground">
						<Trans>Notes</Trans>
					</p>
					<p className="text-sm whitespace-pre-wrap">{key.notes}</p>
				</div>
			)}
		</>
	);
}

export const sshKeyMode: EntryMode = {
	type: "ssh-key",
	get label() {
		return i18n._(msg`SSH key`);
	},
	get description() {
		return i18n._(msg`Public / private key pair`);
	},
	icon: KeyRound,

	emptyForm: () => ({ name: "", publicKey: "", privateKey: "", passphrase: "", notes: "" }),

	toForm: (entry) => {
		const key = entry as SshKeyEntryData;
		return {
			name: key.name,
			publicKey: key.publicKey,
			privateKey: key.privateKey,
			passphrase: key.passphrase ?? "",
			notes: key.notes ?? "",
		};
	},

	toEntry: (values) => {
		const v = values as SshKeyFormValues;
		return {
			type: "ssh-key",
			name: v.name,
			publicKey: v.publicKey,
			privateKey: v.privateKey,
			passphrase: v.passphrase || undefined,
			keyType: deriveKeyType(v.publicKey, v.privateKey),
			notes: v.notes || undefined,
		};
	},

	Fields: SshKeyFields,
	Detail: SshKeyDetail,

	detailSubtitle: (entry) => (entry as SshKeyEntry).keyType || undefined,

	row: (entry) => {
		const key = entry as SshKeyEntry;
		return {
			icon: KeyRound,
			secondary: key.keyType ? i18n._(msg`SSH key · ${key.keyType}`) : i18n._(msg`SSH key`),
			copyItems: [
				...(key.publicKey ? [{ label: i18n._(msg`public key`), value: key.publicKey }] : []),
				...(key.privateKey ? [{ label: i18n._(msg`private key`), value: key.privateKey }] : []),
			],
		};
	},

	searchText: (entry) => {
		const key = entry as SshKeyEntry;
		return `${key.name} ${key.keyType ?? ""} ${key.publicKey}`.toLowerCase();
	},
};
