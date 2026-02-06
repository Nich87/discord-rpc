import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Command, HEARTBEAT_INTERVAL, IPC_VERSION, OpCode, RPCEvent, type LobbyType } from './constants.js';
import { CommandError, ConnectionError, StateError, TimeoutError } from './errors.js';
import { IPCTransport } from './transport.js';
import type {
	Activity,
	AuthenticateResponse,
	AuthorizeOptions,
	AuthorizeResponse,
	AvatarUrlOptions,
	ClientEvents,
	ClientOptions,
	ConnectionState,
	ExchangeCodeOptions,
	LoginOptions,
	ReadyData,
	RPCFrame,
	TokenExchangeResponse,
} from './types.js';

/**
 * Discord RPC Client.
 *
 * Manages the IPC connection to the Discord desktop client,
 * handles command/response correlation via nonces, provides typed events,
 * and offers a high-level API for Rich Presence and other RPC features.
 *
 * @example
 * ```ts
 * import { Client, PresenceBuilder } from 'discord-rpc';
 *
 * const client = new Client();
 * const { user } = await client.login({ clientId: 'YOUR_CLIENT_ID' });
 * console.log(`Logged in as ${user.username}`);
 *
 * client.setActivity(
 *   new PresenceBuilder()
 *     .setDetails('Playing a game')
 *     .setState('In the main menu')
 *     .setStartTimestamp(Date.now())
 *     .build()
 * );
 * ```
 */
export class Client extends EventEmitter<ClientEvents> {
	private readonly transport = new IPCTransport();
	private readonly options: Required<Pick<ClientOptions, 'heartbeatInterval' | 'connectionTimeout'>>;
	private readonly pendingRequests = new Map<
		string,
		{
			resolve: (data: unknown) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();

	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private state: ConnectionState = 'disconnected';
	private clientId: string | null = null;

	/** Current connection state. */
	get connectionState(): ConnectionState {
		return this.state;
	}

	/** Whether the client is ready to send commands. */
	get isReady(): boolean {
		return this.state === 'ready';
	}

	constructor(options: ClientOptions = {}) {
		super();

		this.options = {
			heartbeatInterval: options.heartbeatInterval ?? HEARTBEAT_INTERVAL,
			connectionTimeout: options.connectionTimeout ?? 10_000,
		};

		this.transport.handlePacket((op, data) => {
			this.onPacket(op, data);
		});
		this.transport.handleClose(() => {
			this.onTransportClose();
		});
	}

	// ─── Connection Lifecycle ───────────────────────────────────────────────

	/**
	 * Connect to Discord and perform the RPC handshake.
	 * Resolves with the READY data containing user information.
	 */
	async login(options: LoginOptions): Promise<ReadyData> {
		if (this.state !== 'disconnected') {
			throw new StateError('Client is already connected or connecting. Call destroy() first.');
		}

		this.clientId = options.clientId;
		this.setState('connecting');

		try {
			await this.transport.connect(undefined, this.options.connectionTimeout);
			this.setState('connected');
		} catch (err) {
			this.setState('disconnected');
			throw err;
		}

		return new Promise<ReadyData>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new TimeoutError('Handshake timed out.'));
				void this.destroy();
			}, this.options.connectionTimeout);

			const onReady = (data: ReadyData) => {
				clearTimeout(timer);
				this.setState('ready');
				this.startHeartbeat();
				resolve(data);
			};

			// Use once to auto-cleanup
			this.once('ready', onReady);

			// Send handshake
			this.transport.send(OpCode.Handshake, {
				v: IPC_VERSION,
				client_id: options.clientId,
			});
		});
	}

	/**
	 * Gracefully disconnect from Discord.
	 * Clears activity before closing the connection.
	 */
	async destroy(): Promise<void> {
		// Clear activity if we're in a ready state
		if (this.state === 'ready') {
			try {
				await this.clearActivity();
				// Allow the clear message to flush
				await new Promise<void>((r) => setTimeout(r, 50));
			} catch {
				// Ignore errors during cleanup
			}
		}

		this.stopHeartbeat();
		this.rejectAllPending('Client destroyed.');
		this.transport.destroy();
		this.setState('disconnected');
	}

	// ─── Commands ───────────────────────────────────────────────────────────

	/**
	 * Send a command to Discord and wait for the response.
	 * Automatically handles nonce-based request/response correlation.
	 */
	request<T = unknown>(cmd: Command, args?: Record<string, unknown>, evt?: RPCEvent): Promise<T> {
		if (this.state !== 'ready') {
			return Promise.reject(new StateError('Client is not ready. Call login() first.'));
		}

		const nonce = randomUUID();

		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(nonce);
				reject(new TimeoutError(`Request ${cmd} timed out.`));
			}, this.options.connectionTimeout);

			this.pendingRequests.set(nonce, {
				resolve: resolve as (data: unknown) => void,
				reject,
				timer,
			});

			this.transport.send(OpCode.Frame, { cmd, args, evt, nonce });
		});
	}

	/**
	 * Set the Rich Presence activity.
	 */
	setActivity(activity: Activity): Promise<unknown> {
		return this.request(Command.SetActivity, {
			pid: process.pid,
			activity,
		});
	}

	/**
	 * Clear the current Rich Presence activity.
	 */
	clearActivity(): Promise<unknown> {
		return this.request(Command.SetActivity, {
			pid: process.pid,
			activity: null,
		});
	}

	/**
	 * Request OAuth2 authorization from the user.
	 */
	authorize(options: AuthorizeOptions): Promise<AuthorizeResponse> {
		return this.request<AuthorizeResponse>(Command.Authorize, {
			client_id: options.clientId,
			scopes: options.scopes,
			...options.args,
		});
	}

	/**
	 * Authenticate with an access token to unlock additional RPC features.
	 */
	authenticate(accessToken: string): Promise<AuthenticateResponse> {
		return this.request<AuthenticateResponse>(Command.Authenticate, {
			access_token: accessToken,
		});
	}

	/**
	 * Exchange an authorization code for an access token.
	 * This is a direct HTTP call to Discord's OAuth2 token endpoint.
	 */
	async exchangeCode(options: ExchangeCodeOptions): Promise<TokenExchangeResponse> {
		const response = await fetch('https://discord.com/api/oauth2/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: options.clientId,
				client_secret: options.clientSecret,
				grant_type: 'authorization_code',
				redirect_uri: options.redirectUri,
				code: options.code,
			}),
		});

		if (!response.ok) {
			const body = await response.text();
			throw new CommandError(`OAuth2 token exchange failed (${String(response.status)}): ${body}`, response.status);
		}

		return response.json() as Promise<TokenExchangeResponse>;
	}

	/**
	 * Subscribe to a Discord RPC event.
	 * Returns an unsubscribe function for easy cleanup.
	 */
	async subscribe(event: RPCEvent, args: Record<string, unknown> = {}): Promise<{ unsubscribe: () => Promise<void> }> {
		await this.request(Command.Subscribe, args, event);

		return {
			unsubscribe: async () => {
				await this.request(Command.Unsubscribe, args, event);
			},
		};
	}

	/**
	 * Get the user's relationships (friends list).
	 * Requires authentication with appropriate scopes.
	 */
	getRelationships(): Promise<unknown> {
		return this.request(Command.GetRelationships);
	}

	// ─── Lobby Commands ─────────────────────────────────────────────────────

	createLobby(type: LobbyType, capacity: number, metadata?: Record<string, unknown>): Promise<unknown> {
		return this.request(Command.CreateLobby, { type, capacity, metadata });
	}

	updateLobby(
		lobbyId: string,
		options: {
			type?: LobbyType;
			ownerId?: string;
			capacity?: number;
			metadata?: Record<string, unknown>;
		} = {},
	): Promise<unknown> {
		return this.request(Command.UpdateLobby, {
			id: lobbyId,
			type: options.type,
			owner_id: options.ownerId,
			capacity: options.capacity,
			metadata: options.metadata,
		});
	}

	deleteLobby(lobbyId: string): Promise<unknown> {
		return this.request(Command.DeleteLobby, { id: lobbyId });
	}

	connectToLobby(lobbyId: string, secret: string): Promise<unknown> {
		return this.request(Command.ConnectToLobby, { id: lobbyId, secret });
	}

	disconnectFromLobby(lobbyId: string): Promise<unknown> {
		return this.request(Command.DisconnectFromLobby, { id: lobbyId });
	}

	sendToLobby(lobbyId: string, data: unknown): Promise<unknown> {
		return this.request(Command.SendToLobby, { id: lobbyId, data });
	}

	updateLobbyMember(lobbyId: string, userId: string, metadata?: Record<string, unknown>): Promise<unknown> {
		return this.request(Command.UpdateLobbyMember, {
			lobby_id: lobbyId,
			user_id: userId,
			metadata,
		});
	}

	// ─── Utilities ──────────────────────────────────────────────────────────

	/**
	 * Generate a Discord CDN avatar URL for a user.
	 */
	getAvatarUrl(userId: string, avatarHash?: string | null, options?: AvatarUrlOptions): string {
		const size = options?.size ?? 512;
		const forceStatic = options?.forceStatic ?? false;
		let ext = options?.extension ?? 'png';

		if (!avatarHash) {
			// Default avatar based on user ID
			const index = Number((BigInt(userId) >> 22n) % 6n);
			return `https://cdn.discordapp.com/embed/avatars/${String(index)}.png`;
		}

		if (avatarHash.startsWith('a_') && !forceStatic) {
			ext = 'gif';
		}

		return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}?size=${String(size)}`;
	}

	/**
	 * Send a ping to Discord to keep the connection alive.
	 */
	ping(): void {
		if (this.transport.connected) {
			this.transport.send(OpCode.Ping, { nonce: randomUUID() });
		}
	}

	// ─── Internal ───────────────────────────────────────────────────────────

	private onPacket(op: OpCode, raw: unknown): void {
		// Protocol-level events
		if (op === OpCode.Close) {
			const data = raw as Record<string, unknown>;
			this.emit('disconnected', data.message as string | undefined);
			void this.destroy();
			return;
		}

		if (op === OpCode.Ping) {
			this.transport.send(OpCode.Pong, raw as object);
			return;
		}

		if (op !== OpCode.Frame) return;

		const frame = raw as RPCFrame;

		// READY event
		if (frame.evt === RPCEvent.Ready) {
			this.emit('ready', frame.data as unknown as ReadyData);
			return;
		}

		// Error event (not tied to a request)
		if (frame.evt === RPCEvent.Error && !frame.nonce) {
			const message = (frame.data.message as string | undefined) ?? 'Unknown RPC error';
			const code = (frame.data.code as number | undefined) ?? 0;
			this.emit('error', new CommandError(message, code));
			return;
		}

		// Nonce-based response (resolve pending request)
		if (frame.nonce) {
			const pending = this.pendingRequests.get(frame.nonce);
			if (pending) {
				this.pendingRequests.delete(frame.nonce);
				clearTimeout(pending.timer);

				if (frame.evt === RPCEvent.Error) {
					const message = (frame.data.message as string | undefined) ?? 'Command failed';
					const code = (frame.data.code as number | undefined) ?? 0;
					pending.reject(new CommandError(message, code));
				} else {
					pending.resolve(frame.data);
				}
				return;
			}
		}

		// Dispatch event (from subscriptions)
		if (frame.cmd === Command.Dispatch && frame.evt) {
			this.emit('rpcEvent', frame.evt as RPCEvent, frame.data);
		}
	}

	private onTransportClose(): void {
		this.stopHeartbeat();
		this.rejectAllPending('Transport connection closed.');

		if (this.state !== 'disconnected') {
			this.setState('disconnected');
			this.emit('disconnected', 'Connection closed unexpectedly.');
		}
	}

	private setState(newState: ConnectionState): void {
		if (this.state !== newState) {
			this.state = newState;
			this.emit('stateChange', newState);
		}
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			this.ping();
		}, this.options.heartbeatInterval);
		// Unref so the timer doesn't keep the process alive
		this.heartbeatTimer.unref();
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer !== null) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private rejectAllPending(reason: string): void {
		for (const [nonce, pending] of this.pendingRequests) {
			clearTimeout(pending.timer);
			pending.reject(new ConnectionError(reason));
			this.pendingRequests.delete(nonce);
		}
	}
}
