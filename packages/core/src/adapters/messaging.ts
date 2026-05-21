export interface NativeMessagingAdapter {
	isAvailable(): Promise<boolean>;
	send(message: unknown): Promise<unknown>;
}
