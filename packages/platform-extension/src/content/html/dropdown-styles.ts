import { html } from "../template";

export const dropdownStyles = html`
		<style>
			:host {
				display: block;
			}
			.tp-dropdown {
				background: linear-gradient(135deg, rgba(40, 40, 45, 0.94), rgba(16, 16, 18, 0.94));
				-webkit-backdrop-filter: saturate(180%) blur(20px);
				backdrop-filter: saturate(180%) blur(20px);
				border: 1px solid rgba(255, 255, 255, 0.1);
				border-radius: 16px;
				box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.06);
				font-family:
					-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
				font-size: 13px;
				color: #fff;
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
				background: rgba(255, 255, 255, 0.1);
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
				background: rgba(255, 255, 255, 0.1);
				color: rgba(255, 255, 255, 0.85);
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
				color: #fff;
				line-height: 1.3;
			}
			.tp-user {
				color: rgba(235, 235, 245, 0.6);
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
				color: rgba(235, 235, 245, 0.45);
				transition: color 0.12s ease;
			}
			.tp-item:hover .tp-launch {
				color: rgba(235, 235, 245, 0.85);
			}
			.tp-avatar-suggest {
				background: linear-gradient(135deg, #7c3aed, #2563eb);
				color: #fff;
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
				color: rgba(235, 235, 245, 0.55);
				cursor: pointer !important;
				transition: background 0.12s ease, color 0.12s ease;
			}
			.tp-regenerate:hover {
				background: rgba(255, 255, 255, 0.12);
				color: #fff;
			}
		</style>
	`;
