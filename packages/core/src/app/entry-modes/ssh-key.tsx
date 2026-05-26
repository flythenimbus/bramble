import { Check, Copy, Eye, EyeOff, KeyRound } from "lucide-react";
import { useState } from "react";
import { useFormContext } from "react-hook-form";
import type { SshKeyEntry, SshKeyEntryData } from "../../hooks/useVault";
import { deriveKeyType } from "../../util/ssh";
import { SecretArea } from "../components/ui/secret-area";
import { TextArea } from "../components/ui/text-area";
import { TextField } from "../components/ui/text-field";
import { DetailField } from "./DetailField";
import type { EntryDetailBodyProps, EntryMode } from "./types";

export interface SshKeyFormValues {
	name: string;
	publicKey: string;
	privateKey: string;
	passphrase: string;
	notes: string;
}

function SshKeyFields() {
	const { register } = useFormContext<SshKeyFormValues>();
	const [showPassphrase, setShowPassphrase] = useState(false);

	return (
		<>
			<TextField label="Name" type="text" {...register("name")} />
			<TextArea label="Public key" rows={2} className="font-mono" {...register("publicKey")} />
			<SecretArea label="Private key" rows={6} autoComplete="off" {...register("privateKey")} />
			<TextField
				label="Passphrase (optional)"
				type={showPassphrase ? "text" : "password"}
				autoComplete="off"
				endAdornment={
					<button
						type="button"
						onClick={() => setShowPassphrase((v) => !v)}
						className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
						aria-label={showPassphrase ? "Hide passphrase" : "Show passphrase"}
					>
						{showPassphrase ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
					</button>
				}
				{...register("passphrase")}
			/>
			<TextArea label="Notes (optional)" rows={2} {...register("notes")} />
		</>
	);
}

interface KeyBlockProps {
	label: string;
	value: string;
	copyName: string;
	copied: string | null;
	onCopy: () => void;
	secret?: boolean;
}

function KeyBlock({ label, value, copyName, copied, onCopy, secret }: KeyBlockProps) {
	const [revealed, setRevealed] = useState(false);
	const masked = secret && !revealed;
	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between">
				<p className="text-xs text-muted-foreground">{label}</p>
				<div className="flex items-center gap-1">
					{secret && (
						<button
							type="button"
							onClick={() => setRevealed((v) => !v)}
							className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
							aria-label={revealed ? "Hide private key" : "Show private key"}
						>
							{revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
						</button>
					)}
					<button
						type="button"
						onClick={onCopy}
						className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
						aria-label={`Copy ${label.toLowerCase()}`}
					>
						{copied === copyName ? (
							<Check className="w-3.5 h-3.5 text-primary" />
						) : (
							<Copy className="w-3.5 h-3.5" />
						)}
					</button>
				</div>
			</div>
			<pre className="text-xs font-mono whitespace-pre-wrap break-all rounded-md border border-border/50 p-3 max-h-48 overflow-auto">
				{masked ? "•".repeat(48) : value || "—"}
			</pre>
		</div>
	);
}

function SshKeyDetail({ entry, copied, copy }: EntryDetailBodyProps) {
	const key = entry as SshKeyEntry;
	const [showPassphrase, setShowPassphrase] = useState(false);
	return (
		<>
			{key.publicKey && (
				<KeyBlock
					label="Public key"
					value={key.publicKey}
					copyName="public key"
					copied={copied}
					onCopy={() => copy("public key", key.publicKey)}
				/>
			)}

			<KeyBlock
				label="Private key"
				value={key.privateKey}
				copyName="private key"
				copied={copied}
				onCopy={() => copy("private key", key.privateKey)}
				secret
			/>

			{key.passphrase && (
				<DetailField
					label="Passphrase"
					copied={copied}
					copyName="passphrase"
					onCopy={() => copy("passphrase", key.passphrase ?? "")}
					extraAction={
						<button
							type="button"
							onClick={() => setShowPassphrase((v) => !v)}
							className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
							aria-label={showPassphrase ? "Hide passphrase" : "Show passphrase"}
						>
							{showPassphrase ? (
								<EyeOff className="w-3.5 h-3.5" />
							) : (
								<Eye className="w-3.5 h-3.5" />
							)}
						</button>
					}
				>
					<span className="text-sm font-mono truncate">
						{showPassphrase ? key.passphrase : "•".repeat(Math.min(key.passphrase.length, 16))}
					</span>
				</DetailField>
			)}

			{key.notes && (
				<div className="space-y-1.5">
					<p className="text-xs text-muted-foreground">Notes</p>
					<p className="text-sm whitespace-pre-wrap">{key.notes}</p>
				</div>
			)}
		</>
	);
}

export const sshKeyMode: EntryMode = {
	type: "ssh-key",
	label: "SSH key",
	description: "Public / private key pair",
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
			secondary: key.keyType ? `SSH key · ${key.keyType}` : "SSH key",
			copyItems: [
				...(key.publicKey ? [{ label: "public key", value: key.publicKey }] : []),
				...(key.privateKey ? [{ label: "private key", value: key.privateKey }] : []),
			],
		};
	},

	searchText: (entry) => {
		const key = entry as SshKeyEntry;
		return `${key.name} ${key.keyType ?? ""} ${key.publicKey}`.toLowerCase();
	},
};
