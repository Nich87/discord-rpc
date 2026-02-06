/**
 * Custom error classes for discord-rpc.
 */

/** Base error for all discord-rpc errors. */
export class RPCError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RPCError';
	}
}

/** Thrown when the IPC connection fails. */
export class ConnectionError extends RPCError {
	constructor(message: string) {
		super(message);
		this.name = 'ConnectionError';
	}
}

/** Thrown when Discord returns an error response. */
export class CommandError extends RPCError {
	public readonly code: number;

	constructor(message: string, code: number) {
		super(message);
		this.name = 'CommandError';
		this.code = code;
	}
}

/** Thrown when a request times out. */
export class TimeoutError extends RPCError {
	constructor(message: string = 'Operation timed out') {
		super(message);
		this.name = 'TimeoutError';
	}
}

/** Thrown when a method is called in an invalid state. */
export class StateError extends RPCError {
	constructor(message: string) {
		super(message);
		this.name = 'StateError';
	}
}
