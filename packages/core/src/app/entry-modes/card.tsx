import { CreditCard, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { useFormContext } from "react-hook-form";
import type { CardEntryData } from "../../hooks/useVault";
import { TextArea } from "../components/ui/text-area";
import { TextField } from "../components/ui/text-field";
import { DetailField } from "./DetailField";
import type { EntryDetailBodyProps, EntryMode } from "./types";

export interface CardFormValues {
	name: string;
	cardholderName: string;
	number: string;
	expMonth: string;
	expYear: string;
	cvv: string;
	notes: string;
}

// Best-effort issuer detection from the leading digits, for the icon subtitle
// and search. Not validation — an unknown prefix just yields no brand.
function cardBrand(number: string): string | undefined {
	const n = number.replace(/\D/g, "");
	if (/^4/.test(n)) return "Visa";
	if (/^(5[1-5]|2[2-7])/.test(n)) return "Mastercard";
	if (/^3[47]/.test(n)) return "Amex";
	if (/^6(?:011|5)/.test(n)) return "Discover";
	return undefined;
}

function lastFour(number: string): string {
	return number.replace(/\D/g, "").slice(-4);
}

function cardSubtitle(card: CardEntryData): string {
	const last4 = lastFour(card.number);
	const brand = card.brand ?? cardBrand(card.number);
	const tail = last4 ? `•••• ${last4}` : "";
	return [brand, tail].filter(Boolean).join(" ");
}

function CardFields() {
	const { register } = useFormContext<CardFormValues>();
	const [showNumber, setShowNumber] = useState(false);
	const [showCvv, setShowCvv] = useState(false);

	return (
		<>
			<TextField label="Name" type="text" {...register("name")} />
			<TextField label="Cardholder name" type="text" {...register("cardholderName")} />
			<TextField
				label="Card number"
				type={showNumber ? "text" : "password"}
				inputMode="numeric"
				className="font-mono"
				endAdornment={
					<button
						type="button"
						onClick={() => setShowNumber((v) => !v)}
						className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
						aria-label={showNumber ? "Hide card number" : "Show card number"}
					>
						{showNumber ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
					</button>
				}
				{...register("number")}
			/>

			<div className="grid grid-cols-3 gap-3">
				<TextField
					label="Month (MM)"
					type="text"
					inputMode="numeric"
					maxLength={2}
					{...register("expMonth")}
				/>
				<TextField
					label="Year (YY)"
					type="text"
					inputMode="numeric"
					maxLength={4}
					{...register("expYear")}
				/>
				<TextField
					label="CVV"
					type={showCvv ? "text" : "password"}
					inputMode="numeric"
					maxLength={4}
					endAdornment={
						<button
							type="button"
							onClick={() => setShowCvv((v) => !v)}
							className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
							aria-label={showCvv ? "Hide CVV" : "Show CVV"}
						>
							{showCvv ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
						</button>
					}
					{...register("cvv")}
				/>
			</div>

			<TextArea label="Notes (optional)" rows={2} {...register("notes")} />
		</>
	);
}

function CardDetail({ entry, copied, copy }: EntryDetailBodyProps) {
	const card = entry as CardEntryData & { id: string };
	const [showNumber, setShowNumber] = useState(false);
	const [showCvv, setShowCvv] = useState(false);
	const expiry = [card.expMonth, card.expYear].filter(Boolean).join(" / ");

	return (
		<>
			<DetailField
				label="Cardholder name"
				copied={copied}
				copyName="cardholder name"
				onCopy={() => copy("cardholder name", card.cardholderName)}
			>
				<span className="text-sm truncate">{card.cardholderName || "—"}</span>
			</DetailField>

			<DetailField
				label="Card number"
				copied={copied}
				copyName="card number"
				onCopy={() => copy("card number", card.number)}
				extraAction={
					<button
						type="button"
						onClick={() => setShowNumber((v) => !v)}
						className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
						aria-label={showNumber ? "Hide card number" : "Show card number"}
					>
						{showNumber ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
					</button>
				}
			>
				<span className="text-sm font-mono truncate">
					{showNumber ? card.number : `•••• ${lastFour(card.number)}`}
				</span>
			</DetailField>

			<div className="grid grid-cols-2 gap-3">
				<DetailField
					label="Expires"
					copied={copied}
					copyName="expiry"
					onCopy={() => copy("expiry", expiry)}
				>
					<span className="text-sm font-mono truncate">{expiry || "—"}</span>
				</DetailField>

				<DetailField
					label="CVV"
					copied={copied}
					copyName="CVV"
					onCopy={() => copy("CVV", card.cvv)}
					extraAction={
						<button
							type="button"
							onClick={() => setShowCvv((v) => !v)}
							className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
							aria-label={showCvv ? "Hide CVV" : "Show CVV"}
						>
							{showCvv ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
						</button>
					}
				>
					<span className="text-sm font-mono truncate">
						{showCvv ? card.cvv : "•".repeat(card.cvv.length)}
					</span>
				</DetailField>
			</div>

			{card.notes && (
				<div className="space-y-1.5">
					<p className="text-xs text-muted-foreground">Notes</p>
					<p className="text-sm whitespace-pre-wrap">{card.notes}</p>
				</div>
			)}
		</>
	);
}

export const cardMode: EntryMode = {
	type: "card",
	label: "Payment card",
	description: "Credit or debit card",
	icon: CreditCard,

	emptyForm: () => ({
		name: "",
		cardholderName: "",
		number: "",
		expMonth: "",
		expYear: "",
		cvv: "",
		notes: "",
	}),

	toForm: (entry) => {
		const card = entry as CardEntryData;
		return {
			name: card.name,
			cardholderName: card.cardholderName,
			number: card.number,
			expMonth: card.expMonth,
			expYear: card.expYear,
			cvv: card.cvv,
			notes: card.notes ?? "",
		};
	},

	toEntry: (values) => {
		const v = values as CardFormValues;
		return {
			type: "card",
			name: v.name,
			cardholderName: v.cardholderName,
			number: v.number,
			brand: cardBrand(v.number),
			expMonth: v.expMonth,
			expYear: v.expYear,
			cvv: v.cvv,
			notes: v.notes || undefined,
		};
	},

	Fields: CardFields,
	Detail: CardDetail,

	detailSubtitle: (entry) => cardSubtitle(entry as CardEntryData) || undefined,

	row: (entry) => {
		const card = entry as CardEntryData & { id: string };
		return {
			icon: CreditCard,
			secondary: cardSubtitle(card) || "Payment card",
			copyItems: [{ label: "card number", value: card.number }],
		};
	},

	searchText: (entry) => {
		const card = entry as CardEntryData;
		const brand = card.brand ?? cardBrand(card.number) ?? "";
		return `${card.name} ${card.cardholderName} ${brand} ${lastFour(card.number)}`.toLowerCase();
	},
};
