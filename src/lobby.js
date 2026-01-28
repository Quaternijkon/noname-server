const textDecoder = new TextDecoder();

export class LobbyDurableObject {
	/**
	 * @param {DurableObjectState} state
	 * @param {Record<string, unknown>} env
	 */
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.rooms = [];
		this.events = [];
		this.clients = new Map();
		this.bannedKeys = [];
		this.bannedIps = [];
		this.bannedKeyWords = [];

		// Close any lingering websockets from previous executions where state was lost
		// to force clients to reconnect and re-register.
		this.state.getWebSockets().forEach((ws) => {
			try {
				ws.close(1011, "Server restarted");
			} catch (e) {
				// ignore
			}
		});
	}

	async scheduleAlarm() {
		const currentAlarm = await this.state.storage.getAlarm();
		if (currentAlarm == null) {
			this.state.storage.setAlarm(Date.now() + 10 * 1000);
		}
	}

	async alarm() {
		const now = Date.now();
		const sockets = this.state.getWebSockets();

		if (sockets.length === 0) {
			return;
		}

		for (const ws of sockets) {
			let attachment;
			try {
				attachment = ws.deserializeAttachment();
			} catch {
				ws.close();
				continue;
			}

			if (!attachment || !attachment.wsid) {
				ws.close();
				continue;
			}

			const client = this.clients.get(attachment.wsid);
			if (!client) {
				ws.close();
				continue;
			}

			// Check key validation timeout (2 seconds)
			if (!client.onlineKey && !client.banned && (now - client.connectTime > 2000)) {
				this.sendl(client, "denied", "key");
				// Mark as banned/closing to avoid repeat actions
				client.banned = true;
				// Close shortly after
				// We can just close now for simplicity in alarm
				ws.close();
				continue;
			}

			// Heartbeat Logic (60 seconds)
			if (now - client.lastActivity > 60000) {
				if (client.beatWaiting) {
					// Client didn't respond to previous heartbeat
					ws.close();
					continue;
				} else {
					// Send heartbeat
					client.beatWaiting = true;
					try {
						ws.send("heartbeat");
					} catch {
						ws.close();
					}
				}
			}
		}

		// Schedule next check
		if (this.state.getWebSockets().length > 0) {
			this.state.storage.setAlarm(Date.now() + 10 * 1000);
		}
	}

	/**
	 * @param {Request} request
	 */
	async fetch(request) {
		const upgrade = request.headers.get("Upgrade");
		if (!upgrade || upgrade.toLowerCase() !== "websocket") {
			return new Response("Expected WebSocket", { status: 426 });
		}

		const ipHeader = request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || "";
		const clientIp = ipHeader.split(",")[0].trim() || "unknown";

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];

		this.state.acceptWebSocket(server);
		this.onConnect(server, clientIp);

		return new Response(null, { status: 101, webSocket: client });
	}

	/**
	 * @param {WebSocket} ws
	 * @param {string} clientIp
	 */
	onConnect(ws, clientIp) {
		const wsid = this.getid();
		
		ws.serializeAttachment({ wsid });

		const client = {
			ws,
			wsid,
			nickname: "",
			avatar: "",
			room: null,
			owner: null,
			status: null,
			onlineKey: null,
			servermode: false,
			_onconfig: null,
			clientIp,
			connectTime: Date.now(),
			lastActivity: Date.now(),
			beatWaiting: false,
		};

		this.clients.set(wsid, client);

		if (this.bannedIps.includes(clientIp)) {
			this.sendl(client, "denied", "banned");
			// Utilize alarm to cleanup if needed, or just close immediate
			// For user experience, delay slightly? No, best practice is reject fast if banned.
			// But original code had delay.
			// We will just close it.
			ws.close();
			return;
		}

		// Schedule alarm for checks
		this.scheduleAlarm();

		this.sendl(
			client,
			"roomlist",
			this.getroomlist(),
			this.checkevents(),
			this.getclientlist(),
			client.wsid
		);
	}

	/**
	 * @param {WebSocket} ws
	 * @param {string | ArrayBuffer} message
	 */
	webSocketMessage(ws, message) {
		let attachment;
		try {
			attachment = ws.deserializeAttachment();
		} catch {
			return;
		}

		if (!attachment || !attachment.wsid) return;
		
		const wsid = attachment.wsid;
		const client = this.clients.get(wsid);
		if (!client) {
			return;
		}

		// Update activity
		client.lastActivity = Date.now();
		client.beatWaiting = false;

		const msg = typeof message === "string" ? message : textDecoder.decode(message);
		if (msg === "heartbeat") {
			return;
		}
		if (client.owner) {
			this.sendl(client.owner, "onmessage", client.wsid, msg);
			return;
		}

		let arr;
		try {
			arr = JSON.parse(msg);
			if (!Array.isArray(arr)) {
				throw new Error("err");
			}
		} catch {
			this.sendl(client, "denied", "banned");
			return;
		}

		if (arr.shift() === "server") {
			const type = arr.shift();
			if (typeof this.messages[type] === "function") {
				this.messages[type].call(this, client, ...arr);
			}
		}
	}

	/**
	 * @param {WebSocket} ws
	 */
	webSocketClose(ws) {
		this.handleClose(ws);
	}

	/**
	 * @param {WebSocket} ws
	 */
	webSocketError(ws) {
		this.handleClose(ws);
	}

	/**
	 * @param {WebSocket} ws
	 */
	handleClose(ws) {
		let attachment;
		try {
			attachment = ws.deserializeAttachment();
		} catch {
			return;
		}
		
		if (!attachment || !attachment.wsid) return;

		const wsid = attachment.wsid;
		const client = this.clients.get(wsid);
		if (!client) {
			return;
		}

		for (let i = 0; i < this.rooms.length; i++) {
			if (this.rooms[i].owner === client) {
				for (const [, other] of this.clients) {
					if (other.room === this.rooms[i] && other !== client) {
						this.sendl(other, "selfclose");
					}
				}
				this.rooms.splice(i--, 1);
			}
		}

		if (client.owner) {
			this.sendl(client.owner, "onclose", client.wsid);
		}

		this.cleanupClient(client);

		if (client.room) {
			this.updaterooms();
		} else {
			this.updateclients();
		}
	}

	/**
	 * @param {any} client
	 */
	closeClient(client) {
		try {
			client.ws.close();
		} catch {
			this.cleanupClient(client);
		}
	}

	/**
	 * @param {any} client
	 */
	cleanupClient(client) {
		this.clients.delete(client.wsid);
	}

	getNickname(str) {
		return typeof str === "string" ? str.slice(0, 12) : "无名玩家";
	}

	isBanned(str) {
		if (typeof str !== "string") {
			return false;
		}
		for (const i of this.bannedKeyWords) {
			if (str.indexOf(i) !== -1) {
				return true;
			}
		}
		return false;
	}

	sendl(client, ...args) {
		try {
			client.ws.send(JSON.stringify(args));
		} catch {
			this.closeClient(client);
		}
	}

	getid() {
		return Math.floor(1000000000 + 9000000000 * Math.random()).toString();
	}

	getroomlist() {
		const roomlist = [];
		for (let i = 0; i < this.rooms.length; i++) {
			this.rooms[i]._num = 0;
		}
		for (const [, client] of this.clients) {
			if (client.room && !client.servermode) {
				client.room._num++;
			}
		}
		for (let i = 0; i < this.rooms.length; i++) {
			if (this.rooms[i].servermode) {
				roomlist[i] = "server";
			} else if (this.rooms[i].owner && this.rooms[i].config) {
				if (this.rooms[i]._num === 0) {
					this.sendl(this.rooms[i].owner, "reloadroom");
				}
				roomlist.push([
					this.rooms[i].owner.nickname,
					this.rooms[i].owner.avatar,
					this.rooms[i].config,
					this.rooms[i]._num,
					this.rooms[i].key,
				]);
			}
			delete this.rooms[i]._num;
		}
		return roomlist;
	}

	getclientlist() {
		const clientlist = [];
		for (const [, client] of this.clients) {
			clientlist.push([
				client.nickname,
				client.avatar,
				!client.room,
				client.status,
				client.wsid,
				client.onlineKey,
			]);
		}
		return clientlist;
	}

	updaterooms() {
		const roomlist = this.getroomlist();
		const clientlist = this.getclientlist();
		for (const [, client] of this.clients) {
			if (!client.room) {
				this.sendl(client, "updaterooms", roomlist, clientlist);
			}
		}
	}

	updateclients() {
		const clientlist = this.getclientlist();
		for (const [, client] of this.clients) {
			if (!client.room) {
				this.sendl(client, "updateclients", clientlist);
			}
		}
	}

	checkevents() {
		if (this.events.length) {
			const time = new Date().getTime();
			for (let i = 0; i < this.events.length; i++) {
				if (this.events[i].utc <= time) {
					this.events.splice(i--, 1);
				}
			}
		}
		return this.events;
	}

	updateevents() {
		this.checkevents();
		for (const [, client] of this.clients) {
			if (!client.room) {
				this.sendl(client, "updateevents", this.events);
			}
		}
	}

	messages = {
		create: (client, key, nickname, avatar, config, mode) => {
			if (client.onlineKey !== key) {
				return;
			}
			client.nickname = this.getNickname(nickname);
			client.avatar = avatar;
			const room = {};
			this.rooms.push(room);
			client.room = room;
			delete client.status;
			room.owner = client;
			room.key = key;
			this.sendl(client, "createroom", key);
		},
		enter: (client, key, nickname, avatar, config, mode) => {
			client.nickname = this.getNickname(nickname);
			client.avatar = avatar;
			let room = false;
			for (const i of this.rooms) {
				if (i.key === key) {
					room = i;
					break;
				}
			}
			if (!room) {
				this.sendl(client, "enterroomfailed");
				return;
			}
			client.room = room;
			delete client.status;
			if (room.owner) {
				if (room.servermode && !room.owner._onconfig && config && mode) {
					this.sendl(room.owner, "createroom", room.key, config, mode);
					room.owner._onconfig = client;
					room.owner.nickname = this.getNickname(nickname);
					room.owner.avatar = avatar;
				} else if (!room.config || (room.config.gameStarted && (!room.config.observe || !room.config.observeReady))) {
					this.sendl(client, "enterroomfailed");
				} else {
					client.owner = room.owner;
					this.sendl(client.owner, "onconnection", client.wsid);
				}
				this.updaterooms();
			}
		},
		changeAvatar: (client, nickname, avatar) => {
			client.nickname = this.getNickname(nickname);
			client.avatar = avatar;
			this.updateclients();
		},
		server: (client, cfg) => {
			if (cfg) {
				client.servermode = true;
				const room = this.rooms[cfg[0]];
				if (!room || room.owner) {
					this.sendl(client, "reloadroom", true);
				} else {
					room.owner = client;
					client.room = room;
					client.nickname = this.getNickname(cfg[1]);
					client.avatar = cfg[2];
					this.sendl(client, "createroom", cfg[0], {}, "auto");
				}
			} else {
				for (let i = 0; i < this.rooms.length; i++) {
					if (!this.rooms[i].owner) {
						this.rooms[i].owner = client;
						this.rooms[i].servermode = true;
						client.room = this.rooms[i];
						client.servermode = true;
						break;
					}
				}
				this.updaterooms();
			}
		},
		key: (client, id) => {
			if (!id || typeof id !== "object") {
				this.sendl(client, "denied", "key");
				this.closeClient(client);
				return;
			} else if (this.bannedKeys.indexOf(id[0]) !== -1) {
				this.bannedIps.push(client.clientIp);
				this.closeClient(client);
				return;
			}
			client.onlineKey = id[0];
			// No timeout to clear as we use timestamps now
		},
		events: (client, cfg, id, type) => {
			if (this.bannedKeys.indexOf(id) !== -1 || typeof id !== "string" || client.onlineKey !== id) {
				this.bannedIps.push(client.clientIp);
				this.closeClient(client);
				return;
			}
			let changed = false;
			const time = new Date().getTime();
			if (cfg && id) {
				if (typeof cfg === "string") {
					for (let i = 0; i < this.events.length; i++) {
						if (this.events[i].id === cfg) {
							if (type === "join") {
								if (this.events[i].members.indexOf(id) === -1) {
									this.events[i].members.push(id);
								}
								changed = true;
							} else if (type === "leave") {
								const index = this.events[i].members.indexOf(id);
								if (index !== -1) {
									this.events[i].members.splice(index, 1);
									if (this.events[i].members.length === 0) {
										this.events.splice(i--, 1);
									}
								}
								changed = true;
							}
						}
					}
				} else if (
					Object.prototype.hasOwnProperty.call(cfg, "utc") &&
					Object.prototype.hasOwnProperty.call(cfg, "day") &&
					Object.prototype.hasOwnProperty.call(cfg, "hour") &&
					Object.prototype.hasOwnProperty.call(cfg, "content")
				) {
					if (this.events.length >= 20) {
						this.sendl(client, "eventsdenied", "total");
					} else if (cfg.utc <= time) {
						this.sendl(client, "eventsdenied", "time");
					} else if (this.isBanned(cfg.content)) {
						this.sendl(client, "eventsdenied", "ban");
					} else {
						cfg.nickname = this.getNickname(cfg.nickname);
						cfg.avatar = cfg.nickname || "caocao";
						cfg.creator = id;
						cfg.id = this.getid();
						cfg.members = [id];
						this.events.unshift(cfg);
						changed = true;
					}
				}
			}
			if (changed) {
				this.updateevents();
			}
		},
		config: (client, config) => {
			const room = client.room;
			if (room && room.owner === client) {
				if (room.servermode) {
					room.servermode = false;
					if (client._onconfig) {
						if (this.clients.has(client._onconfig.wsid)) {
							client._onconfig.owner = client;
							this.sendl(client, "onconnection", client._onconfig.wsid);
						}
						client._onconfig = null;
					}
				}
				room.config = config;
			}
			this.updaterooms();
		},
		status: (client, str) => {
			if (typeof str === "string") {
				client.status = str;
			} else {
				delete client.status;
			}
			this.updateclients();
		},
		send: (client, id, message) => {
			const target = this.clients.get(id);
			if (target && target.owner === client) {
				try {
					target.ws.send(message);
				} catch {
					this.closeClient(target);
				}
			}
		},
		close: (client, id) => {
			const target = this.clients.get(id);
			if (target && target.owner === client) {
				this.closeClient(target);
			}
		},
	};
}
