const { EventEmitter } = require("events");

let globalConnectionCount = 0;
const failedAttemptsByUniqueId = new Map();

const FAILED_ATTEMPT_LIMIT = 10;
const BLOCK_DURATION_MS = 60 * 60 * 1000;

function getUniqueIdKey(uniqueId) {
  return String(uniqueId || "")
    .trim()
    .toLowerCase();
}

function getUniqueIdBlockInfo(uniqueId) {
  const uniqueIdKey = getUniqueIdKey(uniqueId);
  if (!uniqueIdKey) {
    return { isBlocked: false, remainingMs: 0 };
  }

  const tracking = failedAttemptsByUniqueId.get(uniqueIdKey);
  if (!tracking || !tracking.blockedUntil) {
    return { isBlocked: false, remainingMs: 0 };
  }

  const remainingMs = tracking.blockedUntil - Date.now();
  if (remainingMs <= 0) {
    failedAttemptsByUniqueId.delete(uniqueIdKey);
    return { isBlocked: false, remainingMs: 0 };
  }

  return { isBlocked: true, remainingMs };
}

function trackFailedConnectionAttempt(uniqueId) {
  const uniqueIdKey = getUniqueIdKey(uniqueId);
  if (!uniqueIdKey) {
    return { isBlocked: false, remainingMs: 0, failedAttempts: 0 };
  }

  const existing = failedAttemptsByUniqueId.get(uniqueIdKey);
  const failedAttempts = (existing?.failedAttempts || 0) + 1;
  const blockedUntil = failedAttempts > FAILED_ATTEMPT_LIMIT ? Date.now() + BLOCK_DURATION_MS : 0;

  failedAttemptsByUniqueId.set(uniqueIdKey, {
    failedAttempts,
    blockedUntil,
  });

  return {
    isBlocked: blockedUntil > Date.now(),
    remainingMs: blockedUntil > 0 ? blockedUntil - Date.now() : 0,
    failedAttempts,
  };
}

function clearFailedConnectionAttempts(uniqueId) {
  const uniqueIdKey = getUniqueIdKey(uniqueId);
  if (!uniqueIdKey) {
    return;
  }

  failedAttemptsByUniqueId.delete(uniqueIdKey);
}

function createBlockedMessage(remainingMs) {
  const remainingMinutes = Math.ceil(remainingMs / (60 * 1000));
  return `Too many failed attempts for this user. Try again in ${remainingMinutes} minute(s).`;
}

/**
 * TikTok LIVE connection wrapper with advanced reconnect functionality and error handling
 */
class TikTokConnectionWrapper extends EventEmitter {
  constructor(uniqueId, options, enableLog, connectorApi) {
    super();

    this.uniqueId = uniqueId;
    this.enableLog = enableLog;

    // Connection State
    this.clientDisconnected = false;
    this.reconnectEnabled = true;
    this.reconnectCount = 0;
    this.reconnectWaitMs = 1000;
    this.maxReconnectAttempts = 5;

    this.connectorApi = connectorApi || {};
    this.webcastEvent = this.connectorApi.WebcastEvent || {};
    this.controlEvent = this.connectorApi.ControlEvent || {};

    const TikTokLiveConnection = this.connectorApi.TikTokLiveConnection;
    if (!TikTokLiveConnection) {
      throw new Error("TikTok connector API is not initialized");
    }

    this.connection = new TikTokLiveConnection(uniqueId, options);

    const streamEndEvent = this.getEventName("streamEnd", this.controlEvent.STREAM_END, this.webcastEvent.STREAM_END);
    const disconnectedEvent = this.getEventName("disconnected", this.controlEvent.DISCONNECTED);
    const errorEvent = this.getEventName("error", this.controlEvent.ERROR);

    this.connection.on(streamEndEvent, () => {
      this.log(`streamEnd event received, giving up connection`);
      this.reconnectEnabled = false;
    });

    this.connection.on(disconnectedEvent, () => {
      globalConnectionCount -= 1;
      this.log(`TikTok connection disconnected`);
      this.scheduleReconnect();
    });

    this.connection.on(errorEvent, (err) => {
      this.log(`Error event triggered: ${err.info}, ${err.exception}`);
      console.error(err);

      if (err.exception && err.exception.toString().includes("liveRoomUserInfo")) {
        this.log("Failed to scrape room info. This is often caused by TikTok blocking the request. Please try adding a SESSIONID to your .env file.");
      }
    });

    // Setup event forwarding for the 'any' event
    this.setupEventForwarding();
  }

  getEventName(defaultEvent, ...eventCandidates) {
    for (const eventCandidate of eventCandidates) {
      if (typeof eventCandidate === "string" && eventCandidate.length > 0) {
        return eventCandidate;
      }
    }

    return defaultEvent;
  }

  setupEventForwarding() {
    // Store the original emit function
    const originalEmit = this.connection.emit;

    // Override the emit function to also emit an 'any' event with the event name and data
    this.connection.emit = function (eventName, ...args) {
      // Call the original emit function to maintain normal functionality
      originalEmit.apply(this, [eventName, ...args]);

      // Don't forward internal events that start with underscore
      if (eventName !== "newListener" && eventName !== "removeListener" && !eventName.startsWith("_")) {
        let eventArgs = args;

        // Avoid forwarding complex objects for 'websocketConnected'
        if (eventName === "websocketConnected") {
          eventArgs = ["[TikTokWsClient]"];
        }

        // Emit a special 'any' event with the original event name and its arguments
        originalEmit.apply(this, ["any", eventName, ...eventArgs]);
      }
    };
  }

  connect(isReconnect) {
    const blockInfo = getUniqueIdBlockInfo(this.uniqueId);
    if (blockInfo.isBlocked) {
      this.reconnectEnabled = false;
      this.log(`Connection blocked for ${Math.ceil(blockInfo.remainingMs / (60 * 1000))} minute(s)`);
      this.emit("disconnected", createBlockedMessage(blockInfo.remainingMs));
      return;
    }

    this.connection
      .connect()
      .then((state) => {
        this.log(`${isReconnect ? "Reconnected" : "Connected"} to roomId ${state.roomId}`);
        clearFailedConnectionAttempts(this.uniqueId);

        globalConnectionCount += 1;

        // Reset reconnect vars
        this.reconnectCount = 0;
        this.reconnectWaitMs = 1000;

        // Client disconnected while establishing connection => drop connection
        if (this.clientDisconnected) {
          this.connection.disconnect();
          return;
        }

        // Notify client
        if (!isReconnect) {
          this.emit("connected", state);
        }
      })
      .catch((err) => {
        this.log(`${isReconnect ? "Reconnect" : "Connection"} failed, ${err}`);

        const failureState = trackFailedConnectionAttempt(this.uniqueId);
        if (failureState.isBlocked) {
          this.reconnectEnabled = false;
          this.emit("disconnected", createBlockedMessage(failureState.remainingMs));
          return;
        }

        if (isReconnect) {
          // Schedule the next reconnect attempt
          this.scheduleReconnect(err);
        } else {
          // Notify client
          this.emit("disconnected", err.toString());
        }
      });
  }

  scheduleReconnect(reason) {
    if (!this.reconnectEnabled) {
      return;
    }

    if (this.reconnectCount >= this.maxReconnectAttempts) {
      this.log(`Give up connection, max reconnect attempts exceeded`);
      this.emit("disconnected", `Connection lost. ${reason}`);
      return;
    }

    this.log(`Try reconnect in ${this.reconnectWaitMs}ms`);

    setTimeout(() => {
      if (!this.reconnectEnabled || this.reconnectCount >= this.maxReconnectAttempts) {
        return;
      }

      this.reconnectCount += 1;
      this.reconnectWaitMs *= 2;
      this.connect(true);
    }, this.reconnectWaitMs);
  }

  disconnect() {
    this.log(`Client connection disconnected`);

    this.clientDisconnected = true;
    this.reconnectEnabled = false;

    if (this.connection?.state?.isConnected || this.connection?.isConnected) {
      this.connection.disconnect();
    }
  }

  log(logString) {
    if (this.enableLog) {
      console.log(`WRAPPER @${this.uniqueId}: ${logString}`);
    }
  }
}

module.exports = {
  TikTokConnectionWrapper,
  getUniqueIdBlockInfo,
  getGlobalConnectionCount: () => {
    return globalConnectionCount;
  },
};
