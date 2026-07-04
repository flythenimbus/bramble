import { html } from "../template";

export const cornerStyles = html`
		<style>
			:host {
				background: rgba(28, 28, 30, 0.96);
				-webkit-backdrop-filter: saturate(180%) blur(20px);
				backdrop-filter: saturate(180%) blur(20px);
				border: 1px solid rgba(255, 255, 255, 0.08);
				border-radius: 14px;
				box-shadow:
					0 16px 48px rgba(0, 0, 0, 0.5),
					0 0 0 1px rgba(0, 0, 0, 0.3);
				font-family:
					-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
				font-size: 13px;
				color: #fff;
				/* Reset inherited text props so a centered/RTL host page can't bleed
				   alignment into the card. */
				text-align: left;
				letter-spacing: normal;
				text-transform: none;
				font-style: normal;
				text-indent: 0;
				padding: 20px;
				box-sizing: border-box;
				width: 360px;
			}
			.tp-head {
				display: flex;
				align-items: flex-start;
				justify-content: space-between;
				gap: 12px;
				margin-bottom: 18px;
			}
			.tp-head-main {
				display: flex;
				align-items: center;
				gap: 12px;
				min-width: 0;
			}
			.tp-icon {
				flex-shrink: 0;
				width: 38px;
				height: 38px;
				border-radius: 11px;
				background: rgba(255, 255, 255, 0.08);
				border: 1px solid rgba(255, 255, 255, 0.08);
				display: flex;
				align-items: center;
				justify-content: center;
				color: #fff;
			}
			.tp-icon svg {
				width: 20px;
				height: 20px;
			}
			.tp-title {
				font-weight: 600;
				font-size: 16px;
				line-height: 1.3;
			}
			.tp-host {
				color: rgba(235, 235, 245, 0.55);
				font-size: 12px;
				margin-top: 4px;
			}
			.tp-close {
				background: transparent;
				border: 0;
				color: rgba(235, 235, 245, 0.55);
				cursor: pointer;
				font-size: 18px;
				line-height: 1;
				padding: 2px 6px;
				border-radius: 6px;
			}
			.tp-close:hover {
				background: rgba(255, 255, 255, 0.06);
				color: #fff;
			}
			.tp-row {
				display: flex;
				flex-direction: column;
				gap: 7px;
				margin-bottom: 14px;
			}
			.tp-label {
				font-size: 11px;
				color: rgba(235, 235, 245, 0.55);
				text-transform: uppercase;
				letter-spacing: 0.5px;
				font-weight: 500;
			}
			input.tp-input {
				background: rgba(255, 255, 255, 0.06);
				border: 1px solid rgba(255, 255, 255, 0.1);
				border-radius: 8px;
				color: #fff;
				padding: 10px 12px;
				font: inherit;
				font-size: 13px;
				outline: none;
				width: 100%;
				box-sizing: border-box;
			}
			input.tp-input:focus {
				border-color: rgba(255, 255, 255, 0.4);
			}
			.tp-password-wrap {
				position: relative;
			}
			.tp-password-toggle {
				position: absolute;
				right: 6px;
				top: 50%;
				transform: translateY(-50%);
				background: transparent;
				border: 0;
				color: rgba(235, 235, 245, 0.55);
				cursor: pointer;
				font-size: 11px;
				padding: 6px 8px;
				border-radius: 6px;
			}
			.tp-password-toggle:hover {
				background: rgba(255, 255, 255, 0.08);
				color: #fff;
			}
			.tp-candidates {
				display: flex;
				flex-direction: column;
				gap: 8px;
				margin-bottom: 16px;
			}
			.tp-candidate {
				display: flex;
				align-items: center;
				gap: 12px;
				padding: 12px 14px;
				background: rgba(255, 255, 255, 0.04);
				border: 1px solid rgba(255, 255, 255, 0.08);
				border-radius: 10px;
				cursor: pointer;
			}
			.tp-candidate:hover {
				background: rgba(255, 255, 255, 0.08);
			}
			.tp-candidate input[type="radio"] {
				accent-color: #fff;
			}
			.tp-candidate .tp-cand-name {
				font-weight: 600;
				font-size: 13px;
			}
			.tp-candidate .tp-cand-user {
				color: rgba(235, 235, 245, 0.55);
				font-size: 12px;
				margin-top: 2px;
			}
			.tp-actions {
				display: flex;
				gap: 10px;
				align-items: center;
				margin-top: 18px;
				position: relative;
			}
			button.tp-btn {
				background: transparent;
				color: #fff;
				border: 1px solid rgba(255, 255, 255, 0.14);
				border-radius: 8px;
				padding: 10px 16px;
				font: inherit;
				font-size: 13px;
				font-weight: 500;
				cursor: pointer;
				transition:
					background 0.1s ease,
					border-color 0.1s ease;
			}
			.tp-btn:hover {
				background: rgba(255, 255, 255, 0.06);
				border-color: rgba(255, 255, 255, 0.24);
			}
			button.tp-btn-primary {
				background: #fafafa;
				color: #18181b;
				border: 1px solid rgba(255, 255, 255, 0.2);
			}
			button.tp-btn-primary:hover {
				background: #e4e4e7;
				border-color: rgba(255, 255, 255, 0.3);
			}
			.tp-overflow {
				margin-left: auto;
				background: transparent;
				border: 1px solid transparent;
				color: rgba(235, 235, 245, 0.55);
				cursor: pointer;
				font-size: 18px;
				padding: 6px 10px;
				border-radius: 8px;
				line-height: 1;
			}
			.tp-overflow:hover {
				background: rgba(255, 255, 255, 0.06);
				border-color: rgba(255, 255, 255, 0.14);
				color: #fff;
			}
			.tp-menu {
				position: absolute;
				right: 0;
				bottom: 52px;
				background: rgba(40, 40, 44, 0.98);
				border: 1px solid rgba(255, 255, 255, 0.1);
				border-radius: 10px;
				padding: 6px;
				box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
				z-index: 1;
				min-width: 160px;
			}
			.tp-menu button {
				background: transparent;
				color: #fff;
				border: 0;
				padding: 9px 12px;
				font: inherit;
				font-size: 13px;
				cursor: pointer;
				border-radius: 6px;
				width: 100%;
				text-align: left;
			}
			.tp-menu button:hover {
				background: rgba(255, 255, 255, 0.08);
			}
		</style>
	`;
