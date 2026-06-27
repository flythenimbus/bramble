import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { BrambleGlyph } from "./components/BrambleGlyph";

interface Props {
	children: ReactNode;
}
interface State {
	error: Error | null;
}

/**
 * Top-level safety net: a render/lifecycle crash anywhere below shows a readable
 * screen instead of a blank one. The fallback avoids the React i18n provider and
 * app hooks — the failure may BE a missing provider — and instead localizes via
 * the global i18n singleton, which returns the English source if no catalog is
 * loaded. Does not catch errors in event handlers or async code (boundaries never do).
 */
export class ErrorBoundary extends Component<Props, State> {
	override state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	override componentDidCatch(error: Error, info: ErrorInfo) {
		console.error("Bramble crashed:", error, info.componentStack);
	}

	override render() {
		const { error } = this.state;
		if (!error) return this.props.children;

		return (
			<div className="min-h-screen flex items-center justify-center bg-background p-6 text-foreground">
				<div className="w-full max-w-md text-center">
					<div className="flex justify-center mb-4">
						<BrambleGlyph className="w-12 h-12 text-foreground" />
					</div>
					<h1 className="text-lg mb-2">{i18n._(msg`Something went wrong`)}</h1>
					<p className="text-sm text-muted-foreground mb-5">
						{i18n._(
							msg`Bramble hit an unexpected error. Your vault is safe — it stays encrypted on this device. Try reloading; if it keeps happening, reopen the app.`,
						)}
					</p>
					<button
						type="button"
						onClick={() => {
							// Drop the caught error first so an in-place remount can recover without a
							// full reload; if the error recurs, the reload button below is the fallback.
							this.setState({ error: null });
						}}
						className="w-full px-5 py-3 text-sm rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all mb-2"
					>
						{i18n._(msg`Try again`)}
					</button>
					<button
						type="button"
						onClick={() => {
							if (typeof location !== "undefined") location.reload();
						}}
						className="w-full px-5 py-3 text-sm rounded-lg border border-border hover:bg-primary/5 active:scale-[0.98] transition-all"
					>
						{i18n._(msg`Reload`)}
					</button>
					{error.message && (
						<pre className="mt-4 text-left text-xs text-muted-foreground bg-card/50 border border-border/50 rounded-lg p-3 overflow-auto max-h-32 whitespace-pre-wrap break-words">
							{error.message}
						</pre>
					)}
				</div>
			</div>
		);
	}
}
