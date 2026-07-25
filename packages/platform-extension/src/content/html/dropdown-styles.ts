import { html } from "../template";

// Colours reference the local --tp-* tokens defined below, never literals. The tokens mirror the
// @vault/theme scale (packages/theme/theme.css); the on-page UI has no Bramble app shell to read a
// `.dark` class, so light/dark follows the OS via prefers-color-scheme. Keep values in sync with
// theme.css. The iframe renderer (autofill-ui.ts) carries a byte-identical copy for its flat bundle.
export const dropdownStyles = html`
		<style>
			:host {
				display: block;
				color-scheme: light dark;
				--tp-surface: #ffffff; /* --popover */
				--tp-foreground: oklch(20.5% 0 0); /* --popover-foreground */
				--tp-muted: oklch(55.6% 0 0); /* --muted-foreground */
				--tp-border: oklch(87% 0 0); /* --border */
				--tp-primary: oklch(20.5% 0 0); /* --primary */
				--tp-on-primary: #ffffff; /* --primary-foreground */
			}
			@media (prefers-color-scheme: dark) {
				:host {
					--tp-surface: oklch(26.9% 0 0);
					--tp-foreground: oklch(97% 0 0);
					--tp-muted: oklch(70.8% 0 0);
					--tp-border: oklch(37.1% 0 0);
					--tp-primary: oklch(97% 0 0);
					--tp-on-primary: oklch(20.5% 0 0);
				}
			}
			.tp-dropdown {
				background: var(--tp-surface);
				border: 1px solid var(--tp-border);
				border-radius: 16px;
				box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(0, 0, 0, 0.15);
				font-family:
					-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
				font-size: 13px;
				color: var(--tp-foreground);
				text-align: left;
				letter-spacing: normal;
				text-transform: none;
				font-style: normal;
				text-indent: 0;
				max-height: 360px;
				overflow-y: auto;
				margin: 0;
				padding: 6px;
				box-sizing: border-box;
			}
			.tp-item {
				padding: 10px 12px;
				cursor: pointer !important;
				display: flex;
				align-items: center;
				gap: 12px;
				border-radius: 12px;
				transition: background 0.12s ease;
			}
			.tp-item:hover {
				background: color-mix(in oklab, var(--tp-foreground) 8%, transparent);
			}
			.tp-avatar {
				width: 40px;
				height: 40px;
				border-radius: 11px;
				display: flex;
				align-items: center;
				justify-content: center;
				font-size: 15px;
				font-weight: 700;
				color: #fff;
				flex-shrink: 0;
				letter-spacing: 0.3px;
				box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18), inset 0 -1px 0 rgba(0, 0, 0, 0.14);
			}
			.tp-avatar-locked {
				background: color-mix(in oklab, var(--tp-foreground) 10%, transparent);
				color: var(--tp-muted);
			}
			.tp-avatar-locked svg {
				width: 20px;
				height: 20px;
			}
			.tp-text {
				display: flex;
				flex-direction: column;
				min-width: 0;
				flex: 1;
			}
			.tp-name {
				font-weight: 600;
				font-size: 15px;
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
				color: var(--tp-foreground);
				line-height: 1.3;
			}
			.tp-user {
				color: var(--tp-muted);
				font-size: 13px;
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
				margin-top: 2px;
				line-height: 1.3;
			}
			.tp-launch {
				margin-left: auto;
				flex-shrink: 0;
				display: flex;
				align-items: center;
				color: var(--tp-muted);
				transition: color 0.12s ease;
			}
			.tp-item:hover .tp-launch {
				color: var(--tp-foreground);
			}
			.tp-avatar-suggest {
				background: var(--tp-primary);
				color: var(--tp-on-primary);
			}
			.tp-avatar-suggest svg {
				width: 20px;
				height: 20px;
			}
			.tp-suggest-pw {
				font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
				font-size: 14px;
				letter-spacing: 0.5px;
			}
			.tp-regenerate {
				margin-left: auto;
				flex-shrink: 0;
				display: flex;
				align-items: center;
				justify-content: center;
				width: 32px;
				height: 32px;
				padding: 0;
				border: 0;
				border-radius: 8px;
				background: transparent;
				color: var(--tp-muted);
				cursor: pointer !important;
				transition: background 0.12s ease, color 0.12s ease;
			}
			.tp-regenerate:hover {
				background: color-mix(in oklab, var(--tp-foreground) 12%, transparent);
				color: var(--tp-foreground);
			}
		</style>
	`;
