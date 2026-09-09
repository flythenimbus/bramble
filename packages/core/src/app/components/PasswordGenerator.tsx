import { Trans, useLingui } from "@lingui/react/macro";
import { Check, Copy, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { usePasswordGenerator } from "../../hooks/usePasswordGenerator";
import {
	type GeneratorMode,
	MAX_LENGTH,
	MAX_PIN,
	MAX_WORDS,
	MIN_LENGTH,
	MIN_PIN,
	MIN_WORDS,
} from "../../util/password-gen";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { RangeField } from "./ui/range-field";
import { SecretText } from "./ui/secret-text";
import { SelectField } from "./ui/select-field";
import { TextField } from "./ui/text-field";
import { cn } from "./ui/utils";

interface PasswordGeneratorProps {
	/** Adopt the value on screen. Omitted leaves out the action row, for embedding somewhere
	 * that commits the value its own way (`value` is on screen and copyable regardless). */
	onUse?: (value: string) => void;
	onCancel?: () => void;
	/** Overrides "Use password", for a caller filling something else. */
	useLabel?: ReactNode;
	className?: string;
}

type ClassKey = "lowercase" | "uppercase" | "digits" | "symbols";

/** The character classes, as (setting, label) pairs so the checkbox row stays one loop. */
const CLASSES: ReadonlyArray<{ key: ClassKey; label: string }> = [
	{ key: "lowercase", label: "a-z" },
	{ key: "uppercase", label: "A-Z" },
	{ key: "digits", label: "0-9" },
	{ key: "symbols", label: "!@#" },
];

/**
 * The password generator, chrome-less. Renders as a plain block so it can sit in the modal the
 * entry form opens, or inline anywhere else that needs one; it owns its settings (which persist)
 * but nothing about its container.
 */
export function PasswordGenerator({
	onUse,
	onCancel,
	useLabel,
	className,
}: PasswordGeneratorProps) {
	const { t } = useLingui();
	const { clipboard } = usePlatform();
	const { settings, set, value, regenerate } = usePasswordGenerator();
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!copied) return;
		const id = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(id);
	}, [copied]);

	const copy = async () => {
		try {
			await clipboard.copy(value);
			setCopied(true);
		} catch {
			// Clipboard can be blocked or unfocused; the value is on screen either way.
		}
	};

	const modes: { mode: GeneratorMode; label: string }[] = [
		{ mode: "password", label: t`Password` },
		{ mode: "passphrase", label: t`Passphrase` },
		{ mode: "pin", label: t`PIN` },
	];

	const enabledClasses = CLASSES.filter((c) => settings[c.key]).length;
	// The last class stays on: with none enabled the generator would have nothing to draw from,
	// so the click is refused rather than silently generating something else.
	const toggleClass = (key: ClassKey, next: boolean) => {
		if (!next && enabledClasses === 1) return;
		set(key, next);
	};

	return (
		<div className={cn("space-y-4", className)}>
			<div className="rounded-lg border border-border bg-muted/30 p-3">
				<div className="flex items-start gap-2">
					<div className="flex-1 min-w-0">
						<SecretText value={value} />
					</div>
					<div className="flex items-center gap-1 shrink-0">
						<Button
							variant="ghost"
							size="none"
							onClick={regenerate}
							className="p-1.5 rounded-md"
							aria-label={t`Generate another`}
						>
							<RefreshCw className="w-3.5 h-3.5" />
						</Button>
						<Button
							variant="ghost"
							size="none"
							onClick={copy}
							className="p-1.5 rounded-md"
							aria-label={t`Copy`}
						>
							{copied ? (
								<Check className="w-3.5 h-3.5 text-primary" />
							) : (
								<Copy className="w-3.5 h-3.5" />
							)}
						</Button>
					</div>
				</div>
			</div>

			<div className="flex gap-0.5 rounded-lg border border-border p-0.5">
				{modes.map((m) => (
					<Button
						key={m.mode}
						variant="ghost"
						size="none"
						onClick={() => set("mode", m.mode)}
						aria-pressed={settings.mode === m.mode}
						className={cn(
							"flex-1 px-2 py-1.5 text-xs rounded-md border-transparent",
							settings.mode === m.mode
								? "bg-primary text-primary-foreground hover:bg-primary"
								: "text-muted-foreground",
						)}
					>
						{m.label}
					</Button>
				))}
			</div>

			{settings.mode === "password" && (
				<div className="space-y-3">
					<RangeField
						label={t`Length`}
						value={settings.length}
						min={MIN_LENGTH}
						max={MAX_LENGTH}
						onChange={(v) => set("length", v)}
					/>
					<div className="grid grid-cols-2 gap-2">
						{CLASSES.map((c) => (
							<Checkbox
								key={c.key}
								checked={settings[c.key]}
								onChange={(next) => toggleClass(c.key, next)}
								className="font-mono"
							>
								{c.label}
							</Checkbox>
						))}
					</div>
					{settings.symbols && (
						// A hair of top padding, so the floated label clears the checkbox row above it.
						<div className="pt-0.5">
							<TextField
								size="sm"
								label={t`Symbols to use`}
								type="text"
								autoComplete="off"
								autoCapitalize="off"
								spellCheck={false}
								className="font-mono"
								value={settings.symbolSet}
								onChange={(e) => set("symbolSet", e.target.value)}
							/>
							{/* Narrowing this is how you get past a site that rejects half of them. An empty
							    box can't mean "no symbols" while the class is on, so say what it does mean. */}
							{!settings.symbolSet.trim() && (
								<p className="mt-1 text-xs text-muted-foreground">
									<Trans>Empty falls back to the standard set.</Trans>
								</p>
							)}
						</div>
					)}
					<Checkbox
						checked={settings.avoidAmbiguous}
						onChange={(next) => set("avoidAmbiguous", next)}
					>
						<Trans>Avoid look-alike characters (0 O l 1)</Trans>
					</Checkbox>
				</div>
			)}

			{settings.mode === "passphrase" && (
				<div className="space-y-3">
					<RangeField
						label={t`Words`}
						value={settings.words}
						min={MIN_WORDS}
						max={MAX_WORDS}
						onChange={(v) => set("words", v)}
					/>
					<SelectField
						label={t`Separator`}
						value={settings.separator}
						onChange={(e) => set("separator", e.target.value)}
					>
						<option value="-">{t`Hyphen (-)`}</option>
						<option value=".">{t`Period (.)`}</option>
						<option value="_">{t`Underscore (_)`}</option>
						<option value=",">{t`Comma (,)`}</option>
						<option value=" ">{t`Space`}</option>
						<option value="">{t`None`}</option>
					</SelectField>
					<Checkbox checked={settings.capitalize} onChange={(next) => set("capitalize", next)}>
						<Trans>Capitalize each word</Trans>
					</Checkbox>
					<Checkbox checked={settings.wordNumber} onChange={(next) => set("wordNumber", next)}>
						<Trans>Include a number</Trans>
					</Checkbox>
				</div>
			)}

			{settings.mode === "pin" && (
				<RangeField
					label={t`Digits`}
					value={settings.pinLength}
					min={MIN_PIN}
					max={MAX_PIN}
					onChange={(v) => set("pinLength", v)}
				/>
			)}

			{onUse && (
				<div className="flex items-center justify-end gap-2 pt-1">
					{onCancel && (
						<Button variant="secondary" size="sm" onClick={onCancel}>
							<Trans>Cancel</Trans>
						</Button>
					)}
					<Button variant="primary" size="sm" onClick={() => onUse(value)} disabled={!value}>
						{useLabel ?? <Trans>Use password</Trans>}
					</Button>
				</div>
			)}
		</div>
	);
}
