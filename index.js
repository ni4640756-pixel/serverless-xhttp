/**
 * Node.js VLESS Server (VLESS over WebSocket)
 * 依赖: npm install ws
 * 运行: node index.js
 */

const http = require('http');
const net = require('net');
const { WebSocketServer } = require('ws');
const { TextDecoder } = require('util');

// --- 1. 全局配置 ---
const PORT = process.env.PORT || 8000;
const UUID = process.env.UUID || 'a2056d0d-c98e-4aeb-9aab-37f64edd5710';
const PROXY_IP = process.env.PROXYIP || ""; // 可选：指定转发IP
const SUB_PATH = process.env.SUB_PATH || "sub"; // 订阅路径

console.log(`Node.js VLESS Server running on port ${PORT}`);
console.log(`UUID: ${UUID}`);

// --- 2. 核心逻辑 ---

/**
 * 解析 VLESS 头部
 */
function parseVlessHeader(buffer) {
    if (buffer.length < 24) {
        return { hasError: true, msg: "Data too short" };
    }
    
    const version = buffer[0];
    const optLen = buffer[17];
    const cmd = buffer[18 + optLen]; // 1=TCP, 2=UDP

    if (cmd !== 1) {
        return { hasError: true, msg: `Unsupported CMD: ${cmd} (Only TCP)` };
    }

    const portIdx = 19 + optLen;
    const port = (buffer[portIdx] << 8) | buffer[portIdx + 1];

    let addrIdx = portIdx + 2;
    const addrType = buffer[addrIdx];
    let hostname = "";
    let rawIndex = 0;

    if (addrType === 1) { // IPv4
        hostname = buffer.subarray(addrIdx + 1, addrIdx + 5).join(".");
        rawIndex = addrIdx + 5;
    } else if (addrType === 2) { // Domain
        const len = buffer[addrIdx + 1];
        hostname = new TextDecoder().decode(buffer.subarray(addrIdx + 2, addrIdx + 2 + len));
        rawIndex = addrIdx + 2 + len;
    } else if (addrType === 3) { // IPv6
        // Node.js处理IPv6相对容易，这里简化处理，直接定位索引
        rawIndex = addrIdx + 17;
        // 简易解析，实际场景IPv6用的少
        const parts = [];
        for (let i = 0; i < 8; i++) {
            parts.push(buffer.readUInt16BE(addrIdx + 1 + i * 2).toString(16));
        }
        hostname = parts.join(':');
    } else {
        return { hasError: true, msg: `Unknown address type: ${addrType}` };
    }

    return { hasError: false, port, hostname, rawIndex, version };
}

/**
 * 处理 VLESS 连接
 */
function handleVlessConnection(ws) {
    let isHeaderParsed = false;
    let remoteConnection = null;

    ws.on('message', (msg) => {
        const chunk = Buffer.from(msg);

        // 1. 已连接状态：直接转发
        if (remoteConnection) {
            // 检查连接是否可写
            if (!remoteConnection.destroyed && remoteConnection.writable) {
                remoteConnection.write(chunk);
            }
            return;
        }

        // 2. 未连接状态：解析头部并连接
        if (!isHeaderParsed) {
            const res = parseVlessHeader(chunk);
            if (res.hasError) {
                console.error(`[Header Error] ${res.msg}`);
                ws.close();
                return;
            }

            isHeaderParsed = true;
            const targetHost = PROXY_IP || res.hostname;
            const targetPort = res.port;

            console.log(`[Connecting] ${res.hostname}:${res.port} -> ${targetHost}`);

            // 建立 TCP 连接 (net.createConnection)
            remoteConnection = net.createConnection(targetPort, targetHost, () => {
                // 连接成功，发送 VLESS 响应头
                const responseHeader = Buffer.alloc(2);
                responseHeader[0] = res.version;
                responseHeader[1] = 0;
                ws.send(responseHeader);

                // 如果 payload 还有剩余数据，一并发送
                if (chunk.length > res.rawIndex) {
                    remoteConnection.write(chunk.subarray(res.rawIndex));
                }
            });

            // 绑定远程 socket 事件
            remoteConnection.on('data', (data) => {
                if (ws.readyState === ws.OPEN) {
                    ws.send(data);
                }
            });

            remoteConnection.on('error', (err) => {
                console.error(`[Remote Error] ${targetHost}:${targetPort} - ${err.message}`);
                ws.close();
            });

            remoteConnection.on('close', () => {
                ws.close();
            });
            
            remoteConnection.on('timeout', () => {
                remoteConnection.destroy();
                ws.close();
            });
        }
    });

    ws.on('close', () => {
        if (remoteConnection) {
            remoteConnection.destroy();
        }
    });

    ws.on('error', (err) => {
        console.error(`[WS Error] ${err.message}`);
        if (remoteConnection) {
            remoteConnection.destroy();
        }
    });
}

// --- 3. 启动 HTTP Server ---

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // 订阅路径 /sub
    if (url.pathname === `/${SUB_PATH}`) {
        const host = req.headers.host;
        // Node通常运行在反代后面，默认 security=none，如果是HTTPS反代请手动改为 tls
        const protocol = "ws"; 
        const path = "/";
        const vlessLink = `vless://${UUID}@${host}:80?encryption=none&security=none&type=ws&host=${host}&path=${path}#Node-${host.split('.')[0]}`;
        
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(Buffer.from(vlessLink).toString('base64'));
        return;
    }

    // 默认响应
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Node.js VLESS Server is Running.\nUUID: ${UUID}`);
});

// --- 4. 绑定 WebSocket Server ---

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    // 这里可以加路径判断，例如只允许 / 路径升级 WS
    // const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    // if (pathname !== '/') { socket.destroy(); return; }

    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

wss.on('connection', (ws) => {
    handleVlessConnection(ws);
});

server.listen(PORT, () => {
    // console.log(`Listening on port ${PORT}`);
});
