import {
	ArrowLeft,
	Clock,
	Download,
	Fingerprint,
	Info,
	Key,
	Lock,
	Palette,
	Shield,
	Upload,
} from "lucide-react";
import { useState } from "react";

interface SettingsProps {
	onBack: () => void;
	darkMode: boolean;
	onToggleTheme: () => void;
}

export function Settings({ onBack, darkMode, onToggleTheme }: SettingsProps) {
	const [autoLockTimeout, setAutoLockTimeout] = useState("15");
	const [biometricsEnabled, setBiometricsEnabled] = useState(false);

	return (
		<main className="max-w-5xl mx-auto px-4 py-5">
			{/* Back button */}
			<button
				onClick={onBack}
				className="flex items-center gap-2 mb-4 text-sm text-muted-foreground hover:text-foreground active:scale-[0.98] transition-all"
			>
				<ArrowLeft className="w-4 h-4" />
				Back to vault
			</button>

			{/* Settings */}
			<div className="space-y-4">
				{/* Security Settings */}
				<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
					<div className="px-4 py-3 border-b border-border/50">
						<h3 className="text-sm flex items-center gap-2">
							<Lock className="w-4 h-4 text-primary" />
							Security
						</h3>
					</div>
					<div className="p-4 space-y-4">
						{/* Auto-lock timeout */}
						<div className="flex items-center justify-between">
							<div className="flex items-start gap-3">
								<div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 flex-shrink-0">
									<Clock className="w-4 h-4 text-primary" />
								</div>
								<div>
									<p className="text-sm">Auto-lock timeout</p>
									<p className="text-xs text-muted-foreground mt-0.5">
										Lock vault after inactivity
									</p>
								</div>
							</div>
							<select
								value={autoLockTimeout}
								onChange={(e) => setAutoLockTimeout(e.target.value)}
								className="px-3 py-1.5 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
							>
								<option value="5">5 minutes</option>
								<option value="15">15 minutes</option>
								<option value="30">30 minutes</option>
								<option value="60">1 hour</option>
								<option value="never">Never</option>
							</select>
						</div>

						{/* Biometrics */}
						<div className="flex items-center justify-between">
							<div className="flex items-start gap-3">
								<div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 flex-shrink-0">
									<Fingerprint className="w-4 h-4 text-primary" />
								</div>
								<div>
									<p className="text-sm">Biometric unlock</p>
									<p className="text-xs text-muted-foreground mt-0.5">Use fingerprint or face ID</p>
								</div>
							</div>
							<button
								onClick={() => setBiometricsEnabled(!biometricsEnabled)}
								className={`relative w-11 h-6 rounded-full border transition-all ${
									biometricsEnabled ? "bg-primary border-primary/20" : "bg-muted border-border"
								}`}
							>
								<div
									className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all ${
										biometricsEnabled ? "left-5" : "left-0.5"
									}`}
								/>
							</button>
						</div>

						{/* Change Master Password */}
						<div className="flex items-center justify-between">
							<div className="flex items-start gap-3">
								<div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 flex-shrink-0">
									<Key className="w-4 h-4 text-primary" />
								</div>
								<div>
									<p className="text-sm">Change master password</p>
									<p className="text-xs text-muted-foreground mt-0.5">
										Update your master password
									</p>
								</div>
							</div>
							<button className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all">
								Change
							</button>
						</div>
					</div>
				</div>

				{/* Appearance */}
				<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
					<div className="px-4 py-3 border-b border-border/50">
						<h3 className="text-sm flex items-center gap-2">
							<Palette className="w-4 h-4 text-primary" />
							Appearance
						</h3>
					</div>
					<div className="p-4">
						<div className="flex items-center justify-between">
							<div className="flex items-start gap-3">
								<div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 flex-shrink-0">
									<Palette className="w-4 h-4 text-primary" />
								</div>
								<div>
									<p className="text-sm">Theme</p>
									<p className="text-xs text-muted-foreground mt-0.5">Choose light or dark mode</p>
								</div>
							</div>
							<div className="flex items-center gap-2">
								<button
									onClick={onToggleTheme}
									className={`px-3 py-1.5 text-xs rounded-lg border transition-all ${
										!darkMode
											? "bg-primary text-primary-foreground border-primary/20"
											: "border-border hover:bg-primary/5 hover:border-primary/50"
									}`}
								>
									Light
								</button>
								<button
									onClick={onToggleTheme}
									className={`px-3 py-1.5 text-xs rounded-lg border transition-all ${
										darkMode
											? "bg-primary text-primary-foreground border-primary/20"
											: "border-border hover:bg-primary/5 hover:border-primary/50"
									}`}
								>
									Dark
								</button>
							</div>
						</div>
					</div>
				</div>

				{/* Data Management */}
				<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
					<div className="px-4 py-3 border-b border-border/50">
						<h3 className="text-sm flex items-center gap-2">
							<Download className="w-4 h-4 text-primary" />
							Data Management
						</h3>
					</div>
					<div className="p-4 space-y-4">
						{/* Export */}
						<div className="flex items-center justify-between">
							<div className="flex items-start gap-3">
								<div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 flex-shrink-0">
									<Download className="w-4 h-4 text-primary" />
								</div>
								<div>
									<p className="text-sm">Export vault</p>
									<p className="text-xs text-muted-foreground mt-0.5">
										Download your passwords as JSON or CSV
									</p>
								</div>
							</div>
							<button className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all">
								Export
							</button>
						</div>

						{/* Import */}
						<div className="flex items-center justify-between">
							<div className="flex items-start gap-3">
								<div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 flex-shrink-0">
									<Upload className="w-4 h-4 text-primary" />
								</div>
								<div>
									<p className="text-sm">Import passwords</p>
									<p className="text-xs text-muted-foreground mt-0.5">
										Import from other password managers
									</p>
								</div>
							</div>
							<button className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all">
								Import
							</button>
						</div>
					</div>
				</div>

				{/* About */}
				<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
					<div className="px-4 py-3 border-b border-border/50">
						<h3 className="text-sm flex items-center gap-2">
							<Info className="w-4 h-4 text-primary" />
							About
						</h3>
					</div>
					<div className="p-4 space-y-3">
						<div className="flex items-center justify-between text-sm">
							<span className="text-muted-foreground">Version</span>
							<span>1.0.0</span>
						</div>
						<div className="flex items-center justify-between text-sm">
							<span className="text-muted-foreground">Total passwords</span>
							<span>10</span>
						</div>
						<div className="flex items-center justify-between text-sm">
							<span className="text-muted-foreground">Vault created</span>
							<span>Jan 15, 2026</span>
						</div>
					</div>
				</div>

				{/* Danger Zone */}
				<div className="rounded-lg border border-destructive/50 bg-card/50 backdrop-blur-sm overflow-hidden">
					<div className="px-4 py-3 border-b border-destructive/50">
						<h3 className="text-sm flex items-center gap-2 text-destructive">
							<Shield className="w-4 h-4" />
							Danger Zone
						</h3>
					</div>
					<div className="p-4">
						<div className="flex items-center justify-between">
							<div>
								<p className="text-sm">Delete vault</p>
								<p className="text-xs text-muted-foreground mt-0.5">
									Permanently delete all your data
								</p>
							</div>
							<button className="px-3 py-1.5 text-xs rounded-lg border border-destructive/50 text-destructive hover:bg-destructive/10 active:scale-[0.98] transition-all">
								Delete
							</button>
						</div>
					</div>
				</div>
			</div>
		</main>
	);
}
