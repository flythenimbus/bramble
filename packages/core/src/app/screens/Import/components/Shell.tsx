export function Shell({ children }: { children: React.ReactNode }) {
	return (
		<div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 flex items-center justify-center p-6">
			<div className="w-full max-w-xl">{children}</div>
		</div>
	);
}
