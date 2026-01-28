const textDecoder = new TextDecoder();

export class LobbyDurableObject {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        
        // 房间状态依然保存在内存中，但建议未来将重要房间持久化到 storage
        this.rooms = []; 
        
        // 封禁列表建议持久化，这里演示内存+持久化混合
        this.bannedIps = [];
        this.bannedKeys = [];
        this.bannedKeyWords = [];
        
        // 恢复持久化数据 (示例)
        this.state.blockConcurrencyWhile(async () => {
            const storedBans = await this.state.storage.get("bannedIps");
            if (storedBans) this.bannedIps = storedBans;
        });
    }

    async fetch(request) {
        const upgrade = request.headers.get("Upgrade");
        if (!upgrade || upgrade.toLowerCase() !== "websocket") {
            return new Response("Expected WebSocket", { status: 426 });
        }

        const ipHeader = request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || "";
        const clientIp = ipHeader.split(",")[0].trim() || "unknown";

        if (this.bannedIps.includes(clientIp)) {
            return new Response("Banned", { status: 403 });
        }

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        // 【最佳实践 1】启用 Hibernation
        // tags 用于群发消息，不再需要遍历 this.clients
        this.state.acceptWebSocket(server, { tags: ["lobby"] });

        const wsid = this.getid();
        
        // 【最佳实践 2】使用 Attachment 存储玩家状态
        // 这样即使 DO 重启，这些数据也会跟随 WebSocket 自动恢复
        const userData = {
            wsid: wsid,
            clientIp: clientIp,
            nickname: "",
            avatar: "",
            roomKey: null, // 只存 ID，不存对象引用
            isOwner: false,
            onlineKey: null,
            status: null,
            connectedAt: Date.now(),
            verified: false // 用于 key check
        };
        
        server.serializeAttachment(userData);

        // 初始化连接逻辑
        this.onConnect(server, userData);

        return new Response(null, { status: 101, webSocket: client });
    }

    onConnect(ws, userData) {
        // 设置一个闹钟，10秒后检查未验证的用户（替代 setTimeout）
        // 注意：生产环境中通常不需要为每个用户设闹钟，这里用惰性检查更省资源，
        // 但为了还原你的逻辑，我们可以在 Alarm 中批量清理。
        // 为简单起见，这里我们在收到第一条消息时检查时间。

        this.sendl(ws, "roomlist", this.getRoomList(), [], this.getClientList(), userData.wsid);
    }

    async webSocketMessage(ws, message) {
        // 【最佳实践 3】每次处理消息先“补水” (Rehydrate)
        // 从 socket 中取出玩家状态
        let userData = ws.deserializeAttachment();
        let stateChanged = false; // 标记是否需要保存回 socket

        // 惰性检查 Key 验证 (替代 setTimeout)
        if (!userData.verified && (Date.now() - userData.connectedAt > 3000)) {
             this.sendl(ws, "denied", "key");
             ws.close();
             return;
        }

        const msg = typeof message === "string" ? message : textDecoder.decode(message);

        // 处理心跳
        // 生产级建议：客户端最好改用标准的 Ping/Pong Frame，那样 DO 不需要醒来。
        // 既然是字符串心跳，我们直接回包，不更新任何状态，尽量快进快出。
        if (msg === "heartbeat") {
            ws.send("heartbeat");
            return;
        }

        try {
            const arr = JSON.parse(msg);
            if (!Array.isArray(arr)) throw new Error("Format error");

            if (arr.shift() === "server") {
                const type = arr.shift();
                if (typeof this.messages[type] === "function") {
                    // 执行业务逻辑，传入 ws 和 userData
                    // 注意：业务逻辑里修改 userData 后，必须设置 stateChanged = true
                    const result = this.messages[type].call(this, ws, userData, ...arr);
                    if (result === true) stateChanged = true; 
                }
            }
        } catch (e) {
            // 格式错误或逻辑错误
            // console.error(e); 
        }

        // 【关键】如果修改了 userData，必须写回 WebSocket
        if (stateChanged) {
            ws.serializeAttachment(userData);
        }
    }

    async webSocketClose(ws, code, reason, wasClean) {
        const userData = ws.deserializeAttachment();
        this.handleLeave(ws, userData);
    }

    async webSocketError(ws, error) {
        const userData = ws.deserializeAttachment();
        this.handleLeave(ws, userData);
    }

    // --- 核心逻辑重构 ---

    handleLeave(ws, userData) {
        // 清理房间逻辑
        if (userData.roomKey) {
            const roomIndex = this.rooms.findIndex(r => r.key === userData.roomKey);
            if (roomIndex !== -1) {
                const room = this.rooms[roomIndex];
                
                // 如果是房主离开
                if (room.ownerWsid === userData.wsid) {
                    // 通知房间其他人
                    this.broadcastToRoom(userData.roomKey, "selfclose");
                    // 删除房间
                    this.rooms.splice(roomIndex, 1);
                } else {
                    // 普通玩家离开，更新房间人数等（如果有计数器）
                }
                this.updateRooms();
            }
        }
        
        // 如果是房主（servermode），通知相关逻辑
        if (userData.isOwner) {
             // 处理 onclose 逻辑...
        }

        this.updateClients();
    }

    // --- 辅助方法 ---

    sendl(ws, ...args) {
        try {
            ws.send(JSON.stringify(args));
        } catch(e) {
            // Ignore send errors, clean up will happen on close event
        }
    }

    getid() {
        return Math.floor(1000000000 + 9000000000 * Math.random()).toString();
    }

    getRoomList() {
        // 重构：动态计算房间人数
        // 在高并发下，遍历所有 socket 算人数太慢。
        // 建议：在 this.rooms 里维护一个 count，进出时更新。
        // 这里演示简单逻辑：
        return this.rooms.map(room => {
            if (room.servermode) return "server";
            // 简单估算人数（生产环境应优化）
            let count = 0; 
            for(const client of this.state.getWebSockets("lobby")) {
                const u = client.deserializeAttachment();
                if(u.roomKey === room.key) count++;
            }
            
            return [
                room.ownerNickname,
                room.ownerAvatar,
                room.config,
                count,
                room.key
            ];
        });
    }

    getClientList() {
        const list = [];
        // 【最佳实践】使用 getWebSockets 获取列表，而不是维护 Map
        for (const ws of this.state.getWebSockets("lobby")) {
            try {
                const u = ws.deserializeAttachment();
                list.push([
                    u.nickname,
                    u.avatar,
                    !u.roomKey, // true if not in room
                    u.status,
                    u.wsid,
                    u.onlineKey
                ]);
            } catch(e) {}
        }
        return list;
    }

    // 群发更新
    broadcast(msg, excludeWs = null) {
        for (const ws of this.state.getWebSockets("lobby")) {
            if (ws === excludeWs) continue;
            try { ws.send(msg); } catch {}
        }
    }
    
    // 给不在房间的人广播
    broadcastLobby(msgType, ...args) {
        const msg = JSON.stringify([msgType, ...args]);
        for (const ws of this.state.getWebSockets("lobby")) {
             const u = ws.deserializeAttachment();
             if (!u.roomKey) { // 只发给大厅的人
                 try { ws.send(msg); } catch {}
             }
        }
    }

    broadcastToRoom(roomKey, ...args) {
        const msg = JSON.stringify(args);
        for (const ws of this.state.getWebSockets("lobby")) {
             const u = ws.deserializeAttachment();
             if (u.roomKey === roomKey) {
                 try { ws.send(msg); } catch {}
             }
        }
    }

    updateRooms() {
        const rList = this.getRoomList();
        const cList = this.getClientList();
        this.broadcastLobby("updaterooms", rList, cList);
    }

    updateClients() {
        const cList = this.getClientList();
        this.broadcastLobby("updateclients", cList);
    }

    // --- 业务消息处理 (解耦版) ---
    // 返回 true 表示 userData 发生了变化，需要保存
    messages = {
        create: function(ws, user, key, nickname, avatar, config, mode) {
            if (user.onlineKey !== key) return false;
            
            user.nickname = this.getNickname(nickname);
            user.avatar = avatar;
            user.roomKey = key;
            user.isOwner = true;
            
            // 存储房间元数据 (不存 socket 对象)
            this.rooms.push({
                key: key,
                ownerWsid: user.wsid, // 存 ID 引用
                ownerNickname: user.nickname,
                ownerAvatar: user.avatar,
                config: config,
                servermode: false,
                configPending: false // 替代 _onconfig
            });
            
            this.sendl(ws, "createroom", key);
            return true; // 保存 user 状态
        },

        enter: function(ws, user, key, nickname, avatar, config, mode) {
            user.nickname = this.getNickname(nickname);
            user.avatar = avatar;
            
            const room = this.rooms.find(r => r.key === key);
            if (!room) {
                this.sendl(ws, "enterroomfailed");
                return true; // 虽然失败，但 nickname 更新了
            }
            
            // 检查房间状态逻辑... (简化)
            // 找到房主的 Socket
            const ownerWs = this.findSocketByWsid(room.ownerWsid);
            
            if (ownerWs) {
                // 原逻辑的迁移
                user.roomKey = room.key;
                this.sendl(ownerWs, "onconnection", user.wsid);
                this.updateRooms();
                return true;
            } else {
                 this.sendl(ws, "enterroomfailed"); // 房主掉线了
                 return true;
            }
        },

        key: function(ws, user, id) {
            if (!id || typeof id !== "object") {
                this.sendl(ws, "denied", "key");
                ws.close();
                return false;
            }
            // 检查封禁 Key
            if(this.bannedKeys.includes(id[0])) {
                // Ban IP logic
                ws.close();
                return false;
            }
            
            user.onlineKey = id[0];
            user.verified = true; // 通过验证
            return true;
        },

        // ... 其他方法类似迁移，重点是将直接的对象引用改为 ID 查找 ...
        
        status: function(ws, user, str) {
            if (typeof str === "string") user.status = str;
            else delete user.status;
            this.updateClients();
            return true;
        }
    };

    // 辅助：通过 ID 找 Socket (比 Map 慢，但这是 Hibernation 的代价)
    // 如果并发极高，可以将 ID->Socket 的映射放在一个临时的 Map 里，
    // 在 constructor 里初始化，在 onMessage 动态维护。
    findSocketByWsid(targetWsid) {
        for (const ws of this.state.getWebSockets("lobby")) {
            const u = ws.deserializeAttachment();
            if (u.wsid === targetWsid) return ws;
        }
        return null;
    }

    getNickname(str) {
        return typeof str === "string" ? str.slice(0, 12) : "无名玩家";
    }
}