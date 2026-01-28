const textDecoder = new TextDecoder();

export class LobbyDurableObject {
    /**
     * @param {DurableObjectState} state
     * @param {Record<string, unknown>} env
     */
    constructor(state, env) {
        this.state = state;
        this.env = env;
        // 核心数据结构保留在内存中
        this.rooms = [];
        this.events = [];
        this.clients = new Map(); // Key: wsid, Value: client object
        // 移除 this.socketToId，改用 ws.serializeAttachment
        
        this.bannedKeys = [];
        this.bannedIps = [];
        this.bannedKeyWords = [];
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

        // 1. 早期拦截
        if (this.bannedIps.includes(clientIp)) {
            return new Response("Banned", { status: 403 });
        }

        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];

        // 2. 启用 Hibernation：设置 tags，不再需要 socketToId map
        this.state.acceptWebSocket(server, { tags: ["lobby"] });
        
        // 3. 将关键元数据直接绑定到 Socket 上 (持久化，不怕内存丢失)
        const wsid = this.getid();
        const metadata = {
            wsid: wsid,
            ip: clientIp,
            joinedAt: Date.now(),
            verified: false // 用于替代 setTimeout keyCheck
        };
        server.serializeAttachment(metadata);

        // 4. 初始化业务对象
        this.createClientWrapper(server, metadata);
        this.onConnect(server, wsid);

        return new Response(null, { status: 101, webSocket: client });
    }

    /**
     * 辅助：构建/重建内存中的 client 对象
     */
    createClientWrapper(ws, metadata) {
        // 如果内存中已存在，直接返回（避免覆盖）
        if (this.clients.has(metadata.wsid)) return this.clients.get(metadata.wsid);

        const client = {
            ws,
            wsid: metadata.wsid,
            clientIp: metadata.ip,
            nickname: "",
            avatar: "",
            room: null,
            owner: null,
            status: null,
            onlineKey: null,
            servermode: false,
            _onconfig: null,
            // 移除定时器句柄，改用状态标记
            // beat: false, // 不再需要主动检测 beat
            // keyCheck: null, // 不再需要句柄
            // heartbeat: null // 不再需要句柄
        };
        this.clients.set(metadata.wsid, client);
        return client;
    }

    /**
     * @param {WebSocket} ws
     * @param {string} wsid
     */
    onConnect(ws, wsid) {
        const client = this.clients.get(wsid);
        if (!client) return; // Should not happen

        // 发送初始化数据
        this.sendl(
            client,
            "roomlist",
            this.getroomlist(),
            this.checkevents(),
            this.getclientlist(),
            client.wsid
        );

        // 注意：移除了 setInterval 和 setTimeout
        // 逻辑改为在收到消息时惰性检查
    }

    /**
     * 系统自动调用的消息处理 (Hibernation 核心)
     * @param {WebSocket} ws
     * @param {string | ArrayBuffer} message
     */
    async webSocketMessage(ws, message) {
        // 1. 获取元数据
        let meta = ws.deserializeAttachment();
        
        // 2. [关键修复] 状态恢复 (Hydration)
        // 如果 DO 刚从休眠唤醒，this.clients 可能是空的。我们需要重建 client 对象。
        let client = this.clients.get(meta.wsid);
        if (!client) {
            client = this.createClientWrapper(ws, meta);
        }

        const msg = typeof message === "string" ? message : textDecoder.decode(message);

        // 3. 心跳处理 (被动响应，零成本)
        if (msg === "heartbeat") {
            try { ws.send("heartbeat"); } catch {}
            return;
        }

        // 4. Key 验证超时检查 (惰性检查，替代 setTimeout)
        // 如果连接超过 2 秒，且尚未验证，且发来的不是 key 消息 -> 踢出
        // 注意：这里需要预判一下消息类型，防止误杀 key 消息
        const now = Date.now();
        if (!meta.verified && (now - meta.joinedAt > 2000)) {
            // 简单预判：如果消息不包含 "key" 字符串，或者解析后不是 key 命令
            // 为了安全，我们先解析，如果是 key 命令则允许
            // 如果解析失败或者不是 key，则踢出
        }

        if (client.owner) {
            this.sendl(client.owner, "onmessage", client.wsid, msg);
            return;
        }

        let arr;
        try {
            arr = JSON.parse(msg);
            if (!Array.isArray(arr)) throw new Error("err");
        } catch {
            this.sendl(client, "denied", "banned");
            return;
        }

        // 5. 验证逻辑：如果未验证，且第一条消息不是 key
        if (!meta.verified) {
             // 检查是否是 key 消息
             const isKeyMsg = (arr.length > 1 && arr[0] === "server" && arr[1] === "key");
             if (!isKeyMsg && (now - meta.joinedAt > 2000)) {
                 this.sendl(client, "denied", "key");
                 this.closeClient(client);
                 return;
             }
        }

        if (arr.shift() === "server") {
            const type = arr.shift();
            if (typeof this.messages[type] === "function") {
                this.messages[type].call(this, client, ...arr);
            }
        }
    }

    async webSocketClose(ws, code, reason, wasClean) {
        this.handleClose(ws);
    }

    async webSocketError(ws, error) {
        this.handleClose(ws);
    }

    handleClose(ws) {
        // 通过 Attachment 找 ID，再找 Client
        let meta;
        try { meta = ws.deserializeAttachment(); } catch { return; }
        
        const client = this.clients.get(meta.wsid);
        if (!client) return;

        // 房间清理逻辑保持不变
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

    closeClient(client) {
        try {
            client.ws.close();
        } catch {
            this.cleanupClient(client);
        }
    }

    cleanupClient(client) {
        // 移除了定时器清理逻辑
        this.clients.delete(client.wsid);
    }

    // --- 业务逻辑保持原样 ---

    getNickname(str) {
        return typeof str === "string" ? str.slice(0, 12) : "无名玩家";
    }

    isBanned(str) {
        if (typeof str !== "string") return false;
        for (const i of this.bannedKeyWords) {
            if (str.indexOf(i) !== -1) return true;
        }
        return false;
    }

    sendl(client, ...args) {
        try {
            client.ws.send(JSON.stringify(args));
        } catch {
            // 如果发送失败，视作断开，但交给 webSocketClose 处理
            // this.closeClient(client); 
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
            if (client.onlineKey !== key) return;
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
            // 更新元数据中的验证状态
            let meta = client.ws.deserializeAttachment();
            meta.verified = true;
            client.ws.serializeAttachment(meta);
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
                // 保持原事件逻辑
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