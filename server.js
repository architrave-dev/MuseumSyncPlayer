/**
 * 전시용 브로드캐스트 싱크 서버
 * - admin 슬롯 1개 고정
 * - 중복 admin 방지
 * - play/pause/seek는 admin만 허용
 * - sender 제외 sync 브로드캐스트
 * - ended/loop 확정은 서버가 담당
 * - heartbeat 기반으로 admin 유실 시 회수
 */

const path = require("path");
const fs = require("fs");
const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;
const ASSET_DIR = path.join(__dirname, "asset");
const ADMIN_KEY = process.env.ADMIN_KEY || "CHANGE_ME";
/** 재생/처음부터 시 viewer가 같은 절대 시각에 시작하도록 주는 유예(초) */
const SCHEDULED_START_LEAD_SEC = 10;

let state = {
  playing: false,
  baseVideoTime: 0,
  baseWallTime: Date.now(),
  mediaDuration: null,
};

let admin = {
  socketId: null,
  sinceMs: 0,
  lastHeartbeatMs: 0,
};

let syncIntervalId = null;

function getCurrentTime() {
  if (!state.playing) return state.baseVideoTime;
  const now = Date.now();
  if (now < state.baseWallTime) return state.baseVideoTime;
  return state.baseVideoTime + (now - state.baseWallTime) / 1000;
}

function clampTime(t) {
  if (typeof t !== "number" || Number.isNaN(t)) return 0;
  if (t < 0) return 0;
  if (typeof state.mediaDuration === "number" && state.mediaDuration > 0) {
    return Math.min(t, state.mediaDuration);
  }
  return t;
}

/** @param {number} [scheduledStartWallMs] 예약 시작 시각(ms). 있으면 그 시각까지 영상 시각을 세지 않음 */
function setPlayingAt(t, scheduledStartWallMs) {
  state.playing = true;
  state.baseVideoTime = clampTime(t);
  state.baseWallTime =
    typeof scheduledStartWallMs === "number" && scheduledStartWallMs > 0
      ? scheduledStartWallMs
      : Date.now();
}

function setPausedAt(t) {
  state.playing = false;
  state.baseVideoTime = clampTime(t);
}

function setSeekAt(t) {
  const nextTime = clampTime(t);

  if (state.playing) {
    state.baseVideoTime = nextTime;
    state.baseWallTime = Date.now();
    return;
  }

  state.baseVideoTime = nextTime;
}

function isAdminSocket(socket) {
  return !!admin.socketId && socket && socket.id === admin.socketId;
}

function clearAdmin(reason) {
  if (!admin.socketId) return;

  const prev = admin.socketId;
  admin.socketId = null;
  admin.sinceMs = 0;
  admin.lastHeartbeatMs = 0;

  io.emit("adminVacant", { reason: reason || "admin cleared" });
  console.log("[ADMIN][CLEARED]", { prev, reason });
}

function tryAssignAdmin(socket, providedKey) {
  if (providedKey !== ADMIN_KEY) {
    socket.emit("adminDenied", { reason: "invalid_key" });
    socket.emit("roleAssigned", { role: "viewer" });
    return false;
  }

  if (admin.socketId && admin.socketId !== socket.id) {
    socket.emit("adminDenied", { reason: "already_taken" });
    socket.emit("roleAssigned", { role: "viewer" });
    return false;
  }

  admin.socketId = socket.id;
  admin.sinceMs = Date.now();
  admin.lastHeartbeatMs = Date.now();

  socket.emit("roleAssigned", { role: "admin" });
  socket.broadcast.emit("roleAssigned", { role: "viewer" });

  console.log("[ADMIN][ASSIGNED]", { socketId: socket.id });
  return true;
}

function restartFromZeroByServer() {
  const serverNow = Date.now() / 1000;
  const startAtServerTime = serverNow + SCHEDULED_START_LEAD_SEC;
  state.playing = true;
  state.baseVideoTime = 0;
  state.baseWallTime = Math.round(startAtServerTime * 1000);

  io.emit("sync", {
    playing: true,
    currentTime: 0,
    startAtServerTime,
    serverNow,
  });
  console.log("[SYNC][SERVER_LOOP]", {
    currentTime: 0,
    playing: true,
    clients: io.sockets.sockets.size,
  });
}

function getSyncIntervalMs() {
  const n = io.sockets.sockets.size;
  if (n > 20) return 3000;
  if (n > 10) return 2500;
  if (n > 3) return 2000;
  return 2000;
}

function scheduleSync() {
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
  }

  const ms = getSyncIntervalMs();

  syncIntervalId = setInterval(() => {
    if (admin.socketId) {
      const age = Date.now() - admin.lastHeartbeatMs;
      if (admin.lastHeartbeatMs > 0 && age > 8000) {
        clearAdmin("heartbeat_timeout");
      }
    }

    if (!state.playing) return;

    const t = getCurrentTime();

    if (
      typeof state.mediaDuration === "number" &&
      state.mediaDuration > 0 &&
      t >= state.mediaDuration
    ) {
      restartFromZeroByServer();
      return;
    }

    io.emit("time", {
      currentTime: t,
      clients: io.sockets.sockets.size,
    });
  }, ms);
}

app.use("/asset", express.static(ASSET_DIR, { maxAge: "24h" }));
app.use(express.static(__dirname));

app.get("/api/video-url", (req, res) => {
  try {
    const names = fs.readdirSync(ASSET_DIR);
    const videoExt = /\.(mp4|mov|webm|m4v)$/i;
    const file = names.find((n) => videoExt.test(n));

    if (!file) {
      return res.status(404).json({ error: "No video in asset folder" });
    }

    res.json({ url: "/asset/" + encodeURIComponent(file) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

io.use((socket, next) => {
  const key = socket.handshake.auth && socket.handshake.auth.adminKey;
  const wantsAdmin = !!key;

  socket.data.role = "viewer";
  socket.data.wantsAdmin = wantsAdmin;

  if (!wantsAdmin) return next();

  if (key !== ADMIN_KEY) {
    socket.data.adminDeniedReason = "invalid_key";
    socket.data.role = "viewer";
    return next();
  }

  if (admin.socketId && admin.socketId !== socket.id) {
    socket.data.adminDeniedReason = "already_taken";
    socket.data.role = "viewer";
    return next();
  }

  socket.data.role = "admin_candidate";
  return next();
});

io.on("connection", (socket) => {
  socket.emit("state", {
    playing: state.playing,
    currentTime: getCurrentTime(),
  });

  if (socket.data.role === "admin_candidate") {
    tryAssignAdmin(socket, socket.handshake.auth.adminKey);
  } else {
    socket.emit("roleAssigned", { role: "viewer" });
    if (socket.data.adminDeniedReason) {
      socket.emit("adminDenied", { reason: socket.data.adminDeniedReason });
    }
  }

  socket.on("requestAdmin", (data) => {
    const key = data && data.adminKey ? data.adminKey : "";
    tryAssignAdmin(socket, key);
  });

  socket.on("releaseAdmin", () => {
    if (isAdminSocket(socket)) clearAdmin("released_by_admin");
  });

  socket.on("heartbeat", () => {
    if (isAdminSocket(socket)) {
      admin.lastHeartbeatMs = Date.now();
    }
  });

  socket.on("mediaReady", (data) => {
    const duration =
      data && typeof data.duration === "number" && isFinite(data.duration)
        ? data.duration
        : null;

    if (duration && duration > 0) {
      state.mediaDuration = duration;
      console.log("[MEDIA_READY]", { duration, socketId: socket.id });
    }
  });

  socket.on("getState", () => {
    const payload = {
      playing: state.playing,
      currentTime: getCurrentTime(),
    };
    if (state.playing && Date.now() < state.baseWallTime) {
      payload.startAtServerTime = state.baseWallTime / 1000;
      payload.serverNow = Date.now() / 1000;
    }
    socket.emit("state", payload);
  });

  socket.on("getServerTime", (data, callback) => {
    if (typeof callback === "function") {
      const serverTime = Date.now() / 1000;
      callback({
        serverTime,
        clientSend: data && typeof data.clientSend === "number" ? data.clientSend : undefined,
      });
    }
  });

  socket.on("play", (data) => {
    if (!isAdminSocket(socket)) {
      socket.emit("notAuthorized", { action: "play" });
      return;
    }

    const t =
      data && typeof data.currentTime === "number"
        ? data.currentTime
        : getCurrentTime();

    const serverNow = Date.now() / 1000;
    const startAtServerTime = serverNow + SCHEDULED_START_LEAD_SEC;
    const scheduledStartWallMs = Math.round(startAtServerTime * 1000);
    setPlayingAt(t, scheduledStartWallMs);
    io.emit("sync", {
      playing: true,
      currentTime: state.baseVideoTime,
      startAtServerTime,
      serverNow,
    });

    console.log("[SYNC][PLAY]", {
      currentTime: state.baseVideoTime,
      sender: socket.id,
      clients: io.sockets.sockets.size,
    });
  });

  socket.on("pause", (data) => {
    if (!isAdminSocket(socket)) {
      socket.emit("notAuthorized", { action: "pause" });
      return;
    }

    const t =
      data && typeof data.currentTime === "number"
        ? data.currentTime
        : getCurrentTime();

    setPausedAt(t);

    socket.broadcast.emit("sync", {
      playing: false,
      currentTime: state.baseVideoTime,
    });

    console.log("[SYNC][PAUSE]", {
      currentTime: state.baseVideoTime,
      sender: socket.id,
      clients: io.sockets.sockets.size,
    });
  });

  socket.on("seek", (data) => {
    if (!isAdminSocket(socket)) {
      socket.emit("notAuthorized", { action: "seek" });
      return;
    }

    const t =
      data && typeof data.currentTime === "number" ? data.currentTime : 0;

    setSeekAt(t);

    socket.broadcast.emit("sync", {
      playing: state.playing,
      currentTime: state.baseVideoTime,
    });

    console.log("[SYNC][SEEK]", {
      currentTime: state.baseVideoTime,
      playing: state.playing,
      sender: socket.id,
      clients: io.sockets.sockets.size,
    });
  });

  socket.on("disconnect", () => {
    if (isAdminSocket(socket)) {
      clearAdmin("disconnect");
    }
    scheduleSync();
  });

  scheduleSync();
});

scheduleSync();

httpServer.listen(PORT, () => {
  console.log("Video Player for Museum - broadcast sync server");
  console.log("http://localhost:" + PORT);
  console.log("ADMIN_KEY env is required for production.");
});
