let ipRequestCounts = {};
let ipFailedAttempts = {};
let ipBlockedUntil = {};

let maxIpConnections = 10;
let maxIpRequestsPerMinute = 5;
let maxFailedAttempts = 10;
let blockDurationMs = 60 * 60 * 1000; // 1 hour

setInterval(() => {
    ipRequestCounts = {};
}, 60 * 1000);

setInterval(() => {
    const now = Date.now();
    for (const ip in ipBlockedUntil) {
        if (ipBlockedUntil[ip] <= now) {
            delete ipBlockedUntil[ip];
            delete ipFailedAttempts[ip];
            console.info(`LIMITER: Ban expired for IP ${ip}`);
        }
    }
}, 5 * 60 * 1000); // Check every 5 minutes

function clientBlocked(io, currentSocket) {
    let ipCounts = getOverallIpConnectionCounts(io);
    let currentIp = getSocketIp(currentSocket);

    if (typeof currentIp !== 'string') {
        console.info('LIMITER: Failed to retrieve socket IP.');
        return false;
    }

    // Check if IP is blocked due to failed attempts
    if (isIpBlockedByFailures(currentIp)) {
        console.info(`LIMITER: IP ${currentIp} is blocked due to too many failed connection attempts`);
        return true;
    }

    let currentIpConnections = ipCounts[currentIp] || 0;
    let currentIpRequests = ipRequestCounts[currentIp] || 0;

    ipRequestCounts[currentIp] = currentIpRequests + 1;

    if (currentIpConnections > maxIpConnections) {
        console.info(`LIMITER: Max connection count of ${maxIpConnections} exceeded for client ${currentIp}`);
        return true;
    }

    if (currentIpRequests > maxIpRequestsPerMinute) {
        console.info(`LIMITER: Max request count of ${maxIpRequestsPerMinute} exceeded for client ${currentIp}`);
        return true;
    }

    return false;
}

function getOverallIpConnectionCounts(io) {
    let ipCounts = {};

    io.of('/').sockets.forEach(socket => {
        let ip = getSocketIp(socket);
        if (!ipCounts[ip]) {
            ipCounts[ip] = 1;
        } else {
            ipCounts[ip] += 1;
        }
    })

    return ipCounts;
}


function isIpBlockedByFailures(ip) {
    if (ipBlockedUntil[ip] && ipBlockedUntil[ip] > Date.now()) {
        return true;
    }
    return false;
}

function recordFailedAttempt(ip) {
    if (!ipFailedAttempts[ip]) {
        ipFailedAttempts[ip] = 0;
    }
    
    ipFailedAttempts[ip] += 1;
    console.info(`LIMITER: Failed attempt for IP ${ip} (${ipFailedAttempts[ip]}/${maxFailedAttempts})`);
    
    if (ipFailedAttempts[ip] >= maxFailedAttempts) {
        ipBlockedUntil[ip] = Date.now() + blockDurationMs;
        console.info(`LIMITER: IP ${ip} blocked for 1 hour due to ${maxFailedAttempts} failed attempts`);
    }
}

function resetFailedAttempts(ip) {
    if (ipFailedAttempts[ip]) {
        delete ipFailedAttempts[ip];
        console.info(`LIMITER: Failed attempts counter reset for IP ${ip}`);
    }
}

function getSocketIp(socket) {
    if (['::1', '::ffff:127.0.0.1'].includes(socket.handshake.address)) {
        return socket.handshake.headers['x-forwarded-for'];
    } else {
        return socket.handshake.address;
    }
}

module.exports = {
    clientBlocked,
    recordFailedAttempt,
    resetFailedAttempts,
    getSocketIp
}