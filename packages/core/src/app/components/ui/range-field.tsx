import { type ComponentProps, useId } from "react";
import { cn } from "./utils";

interface RangeFieldProps
	extends Omit<ComponentProps<"input">, "id" | "type" | "value" | "onChange"> {
	label: string;
	value: number;
	min: number;
	max: number;
	onChange: (value: number) => void;
}

/** Slider with its current value read out beside the label. */
export function RangeField({
	label,
	value,
	min,
	max,
	onChange,
	className,
	...props
}: RangeFieldProps) {
	const id = useId();
	return (
		<div className={className}>
			<div className="flex items-center justify-between mb-1">
				<label htmlFor={id} className="text-xs text-muted-foreground">
					{label}
				</label>
				<span className="text-xs tabular-nums">{value}</span>
			</div>
			<input
				id={id}
				type="range"
				min={min}
				max={max}
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				className={cn(
					"w-full h-5 cursor-pointer accent-primary bg-transparent",
					"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full",
				)}
				{...props}
			/>
		</div>
	);
}
