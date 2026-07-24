const NATIVE_ERROR_FALLBACK = "Native provider failed";

export function nativeErrorText(error: unknown): string {
	try {
		if (error instanceof Error) {
			const message = error.message;
			return typeof message === "string" ? message : String(message);
		}
		return String(error);
	} catch {
		return NATIVE_ERROR_FALLBACK;
	}
}
