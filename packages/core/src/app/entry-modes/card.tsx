import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { CreditCard, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { useFormContext } from "react-hook-form";
import type { CardEntryData } from "../../hooks/useVault";
import { cardBrand } from "../../util/card";
import { Button } from "../components/ui/button";
import { TextArea } from "../components/ui/text-area";
import { TextField } from "../components/ui/text-field";
import { DetailField, DetailValue } from "./DetailField";
import type { EntryDetailBodyProps, EntryMode } from "./types";

interface CardFormValues {
	name: string;
	cardholderName: string;
	number: string;
	expMonth: string;
	expYear: string;
	cvv: string;
	notes: string;
}

function lastFour(number: string): string {
	return number.replace(/\D/g, "").slice(-4);
}

/** "Visa •••• 1234", or just the last four when the brand is unknown. */
function cardSubtitle(card: CardEntryData): string {
	const last4 = lastFour(card.number);
	const brand = card.brand ?? cardBrand(card.number);
	const tail = last4 ? `•••• ${last4}` : "";
	return [brand, tail].filter(Boolean).join(" ");
}

/** "04 / 2030". Shared so the detail view and the list's copy menu agree. */
function cardExpiry(card: CardEntryData): string {
	return [card.expMonth, card.expYear].filter(Boolean).join(" / ");
}

function CardFields() {
	const { register } = useFormContext<CardFormValues>();
	const { t } = useLingui();
	const [showNumber, setShowNumber] = useState(false);
	const [showCvv, setShowCvv] = useState(false);

	return (
		<>
			<TextField label={t`Name`} type="text" autoComplete="off" {...register("name")} />
			<TextField
				label={t`Cardholder name`}
				type="text"
				autoComplete="off"
				{...register("cardholderName")}
			/>
			<TextField
				label={t`Card number`}
				type={showNumber ? "text" : "password"}
				inputMode="numeric"
				autoComplete="off"
				className="font-mono"
				endAdornment={
					<Button
						variant="ghost"
						size="none"
						onClick={() => setShowNumber((v) => !v)}
						className="p-1.5 rounded-md"
						aria-label={showNumber ? t`Hide card number` : t`Show card number`}
					>
						{showNumber ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
					</Button>
				}
				{...register("number")}
			/>

			<div className="grid grid-cols-3 gap-3">
				<TextField
					label={t`Month (MM)`}
					type="text"
					inputMode="numeric"
					autoComplete="off"
					maxLength={2}
					{...register("expMonth")}
				/>
				<TextField
					label={t`Year (YY)`}
					type="text"
					inputMode="numeric"
					autoComplete="off"
					maxLength={4}
					{...register("expYear")}
				/>
				<TextField
					label={t`CVV`}
					type={showCvv ? "text" : "password"}
					inputMode="numeric"
					autoComplete="off"
					maxLength={4}
					endAdornment={
						<Button
							variant="ghost"
							size="none"
							onClick={() => setShowCvv((v) => !v)}
							className="p-1.5 rounded-md"
							aria-label={showCvv ? t`Hide CVV` : t`Show CVV`}
						>
							{showCvv ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
						</Button>
					}
					{...register("cvv")}
				/>
			</div>

			<TextArea label={t`Notes (optional)`} rows={2} {...register("notes")} />
		</>
	);
}

function CardDetail({ entry, copied, copy }: EntryDetailBodyProps) {
	const card = entry as CardEntryData & { id: string };
	const { t } = useLingui();
	const [showNumber, setShowNumber] = useState(false);
	const [showCvv, setShowCvv] = useState(false);
	const expiry = cardExpiry(card);

	return (
		<>
			<DetailField
				label={t`Cardholder name`}
				copied={copied}
				copyName="cardholder name"
				onCopy={() => copy("cardholder name", card.cardholderName)}
			>
				<DetailValue>{card.cardholderName || "-"}</DetailValue>
			</DetailField>

			<DetailField
				label={t`Card number`}
				copied={copied}
				copyName="card number"
				onCopy={() => copy("card number", card.number)}
				extraAction={
					<Button
						variant="ghost"
						size="none"
						onClick={() => setShowNumber((v) => !v)}
						className="p-1.5 rounded-md"
						aria-label={showNumber ? t`Hide card number` : t`Show card number`}
					>
						{showNumber ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
					</Button>
				}
			>
				<DetailValue mono wrap={showNumber}>
					{showNumber ? card.number : `•••• ${lastFour(card.number)}`}
				</DetailValue>
			</DetailField>

			<div className="grid grid-cols-2 gap-3">
				<DetailField
					label={t`Expires`}
					copied={copied}
					copyName="expiry"
					onCopy={() => copy("expiry", expiry)}
				>
					<DetailValue mono>{expiry || "-"}</DetailValue>
				</DetailField>

				<DetailField
					label={t`CVV`}
					copied={copied}
					copyName="CVV"
					onCopy={() => copy("CVV", card.cvv)}
					extraAction={
						<Button
							variant="ghost"
							size="none"
							onClick={() => setShowCvv((v) => !v)}
							className="p-1.5 rounded-md"
							aria-label={showCvv ? t`Hide CVV` : t`Show CVV`}
						>
							{showCvv ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
						</Button>
					}
				>
					<DetailValue mono wrap={showCvv}>
						{showCvv ? card.cvv : "•".repeat(card.cvv.length)}
					</DetailValue>
				</DetailField>
			</div>

			{card.notes && (
				<div className="space-y-1.5">
					<p className="text-xs text-muted-foreground">
						<Trans>Notes</Trans>
					</p>
					<p className="text-sm whitespace-pre-wrap">{card.notes}</p>
				</div>
			)}
		</>
	);
}

/** EntryMode for payment cards. */
export const cardMode: EntryMode = {
	type: "card",
	get label() {
		return i18n._(msg`Payment card`);
	},
	get description() {
		return i18n._(msg`Credit or debit card`);
	},
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
			secondary: cardSubtitle(card) || i18n._(msg`Payment card`),
			// Each is omitted when empty rather than offering a row that copies nothing.
			copyItems: [
				...(card.number ? [{ label: i18n._(msg`card number`), value: card.number }] : []),
				...(cardExpiry(card) ? [{ label: i18n._(msg`expiry`), value: cardExpiry(card) }] : []),
				...(card.cvv ? [{ label: i18n._(msg`CVV`), value: card.cvv }] : []),
			],
		};
	},

	searchText: (entry) => {
		const card = entry as CardEntryData;
		const brand = card.brand ?? cardBrand(card.number) ?? "";
		return `${card.name} ${card.cardholderName} ${brand} ${lastFour(card.number)}`.toLowerCase();
	},
};
