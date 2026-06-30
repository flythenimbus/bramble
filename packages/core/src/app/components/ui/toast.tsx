import {
	type ComponentType,
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";

// Centralized, app-wide toast/alert. Mount <ToastProvider> once near the root; call
// useToast().show({...}) from anywhere in core. Variant styling lives here so every
// toast looks consistent (success/error/info). See PasskeySavedToast for a usage example.

export type ToastVariant = "success" | "error" | "info";

export interface ToastOptions {
	message: string;
	variant?: ToastVariant;
	/** Optional leading icon (e.g. a lucide icon component). */
	icon?: ComponentType<{ className?: string }>;
	/** Auto-dismiss after this many ms; 0 keeps it until dismissed. Default 4000. */
	durationMs?: number;
}

interface ToastItem extends ToastOptions {
	id: number;
}

interface ToastApi {
	show: (options: ToastOptions) => number;
	dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
	const ctx = useContext(ToastContext);
	if (!ctx) throw new Error("useToast called outside ToastProvider");
	return ctx;
}

// One place for variant appearance. Solid fills with white text for AA contrast on the
// dark chrome (the translucent accent tints blend in); info uses the neutral surface.
const VARIANT_CLASS: Record<ToastVariant, string> = {
	success: "bg-emerald-700 text-white border-emerald-500/60",
	error: "bg-red-700 text-white border-red-500/60",
	info: "bg-muted text-foreground border-border",
};

export function ToastProvider({ children }: { children: ReactNode }) {
	const [toasts, setToasts] = useState<ToastItem[]>([]);
	const nextId = useRef(1);

	const dismiss = useCallback((id: number) => {
		setToasts((list) => list.filter((t) => t.id !== id));
	}, []);

	const show = useCallback(
		(options: ToastOptions) => {
			const id = nextId.current++;
			// Squash duplicates: if a toast with the same message + variant is already showing,
			// don't stack another (e.g. draining N pending passkeys for one site fires N identical
			// toasts). The functional updater sees the latest list, so a rapid burst dedupes.
			const variant = options.variant ?? "info";
			setToasts((list) =>
				list.some((t) => t.message === options.message && (t.variant ?? "info") === variant)
					? list
					: [...list, { ...options, id }],
			);
			// Harmless if this id was deduped away (dismiss then filters out nothing).
			const duration = options.durationMs ?? 4000;
			if (duration > 0) setTimeout(() => dismiss(id), duration);
			return id;
		},
		[dismiss],
	);

	const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

	return (
		<ToastContext.Provider value={api}>
			{children}
			<ToastViewport toasts={toasts} onDismiss={dismiss} />
		</ToastContext.Provider>
	);
}

function ToastViewport({
	toasts,
	onDismiss,
}: {
	toasts: ToastItem[];
	onDismiss: (id: number) => void;
}) {
	if (toasts.length === 0) return null;
	return (
		<div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2">
			{toasts.map((toast) => (
				<ToastRow key={toast.id} toast={toast} onDismiss={() => onDismiss(toast.id)} />
			))}
		</div>
	);
}

function ToastRow({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
	const Icon = toast.icon;
	return (
		// The status div is the live-region announcement; the × is the (focusable) dismiss.
		<div
			role="status"
			aria-live="polite"
			className={`flex items-center gap-2 px-3.5 py-2 rounded-lg border shadow-lg text-sm font-medium ${VARIANT_CLASS[toast.variant ?? "info"]}`}
		>
			{Icon && <Icon className="w-4 h-4 shrink-0" />}
			<span>{toast.message}</span>
			<button
				type="button"
				onClick={onDismiss}
				aria-label="Dismiss"
				className="ml-1 -mr-1 px-1 leading-none opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current rounded"
			>
				×
			</button>
		</div>
	);
}
