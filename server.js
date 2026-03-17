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
const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;
const HLS_VENDOR_DIR = path.join(__dirname, "node_modules", "hls.js", "dist");
const ADMIN_KEY = process.env.ADMIN_KEY || "CHANGE_ME";
const MEDIA_BASE_URL = (process.env.MEDIA_BASE_URL || "").replace(/\/+$/, "");
const MEDIA_PREFIX = (process.env.MEDIA_PREFIX || "museum-sync-player/01_ilmin").replace(
  /^\/+|\/+$/g,
  "",
);
/** 재생/처음부터 시 viewer가 같은 절대 시각에 시작하도록 주는 유예(초) */
const SCHEDULED_START_LEAD_SEC = 5;
const MAX_VIDEO_COUNT = 8;

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

const viewerSlotsBySocketId = new Map();

let syncIntervalId = null;
let scheduledSeekTimeoutId = null;

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

function setHlsHeaders(res, filePath) {
  if (filePath.endsWith(".m3u8")) {
    res.type("application/vnd.apple.mpegurl");
    return;
  }
  if (filePath.endsWith(".ts")) {
    res.type("video/mp2t");
    return;
  }
  if (filePath.endsWith(".m4s")) {
    res.type("video/iso.segment");
  }
}

function parseVideoSlots(value) {
  const slots = String(value || "")
    .split(",")
    .map((item) => Number(String(item).trim()))
    .filter((slot) => Number.isInteger(slot) && slot >= 1 && slot <= MAX_VIDEO_COUNT);

  if (!slots.length) return [];

  return Array.from(new Set(slots)).sort((a, b) => a - b);
}

function getConfiguredVideoSlots() {
  const configuredSlots = parseVideoSlots(process.env.VIDEO_SLOTS || "1,2,3,4,5,6,7,8");
  return configuredSlots.length ? configuredSlots : [1];
}

function getOccupiedVideoSlots() {
  const occupied = new Set();

  if (admin.socketId && getConfiguredVideoSlots().indexOf(1) >= 0) {
    occupied.add(1);
  }

  viewerSlotsBySocketId.forEach((slot) => {
    if (Number.isInteger(slot)) occupied.add(slot);
  });

  return occupied;
}

function assignViewerSlot(socket, preferredSlot) {
  const availableSlots = getConfiguredVideoSlots();
  const preferred = Number(preferredSlot);

  viewerSlotsBySocketId.delete(socket.id);

  let assignedSlot = null;

  if (availableSlots.indexOf(preferred) >= 0) {
    assignedSlot = preferred;
  }

  if (assignedSlot === null) {
    assignedSlot = availableSlots[0];
  }

  viewerSlotsBySocketId.set(socket.id, assignedSlot);
  socket.data.selectedVideoSlot = assignedSlot;

  return {
    assignedSlot,
    availableSlots,
    occupiedSlots: Array.from(getOccupiedVideoSlots()).sort((a, b) => a - b),
  };
}

function buildMediaUrl(parts) {
  if (!MEDIA_BASE_URL) return "";

  const cleanedParts = parts
    .filter(Boolean)
    .map((part) => String(part).replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);

  return [MEDIA_BASE_URL].concat(cleanedParts).join("/");
}

function getSlotFolderName(slot) {
  return String(slot).padStart(2, "0");
}

function getSlotManifestUrl(slot) {
  return buildMediaUrl([MEDIA_PREFIX, getSlotFolderName(slot), "hls", "playlist.m3u8"]);
}

function getAvailableVideos() {
  if (!MEDIA_BASE_URL) return [];

  return getConfiguredVideoSlots().map((slot) => ({
    slot,
    type: "hls",
    url: getSlotManifestUrl(slot),
  }));
}

app.use("/vendor/hls", express.static(HLS_VENDOR_DIR, { maxAge: "24h" }));
app.use(express.static(__dirname));

app.get("/api/videos", (_req, res) => {
  try {
    const videos = getAvailableVideos();
    if (videos.length === 0) {
      return res.status(404).json({
        error: "No S3 HLS playlists configured. Check MEDIA_BASE_URL and VIDEO_SLOTS.",
      });
    }

    res.json({ videos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/video-url", (_req, res) => {
  try {
    const videos = getAvailableVideos();
    const firstVideo = videos.find((video) => video.slot === 1) || videos[0];
    if (!firstVideo) {
      return res.status(404).json({
        error: "No S3 HLS playlists configured. Check MEDIA_BASE_URL and VIDEO_SLOTS.",
      });
    }
    res.json(firstVideo);
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

  socket.on("claimVideoSlot", (data, callback) => {
    const result = assignViewerSlot(
      socket,
      data && typeof data.preferredSlot === "number" ? data.preferredSlot : null,
    );

    if (typeof callback === "function") {
      callback(result);
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
      forceSeek: true,
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

  socket.on("scheduleSeek", (data) => {
    if (!isAdminSocket(socket)) {
      socket.emit("notAuthorized", { action: "scheduleSeek" });
      return;
    }

    const t =
      data && typeof data.currentTime === "number" ? data.currentTime : 0;
    const label =
      data && typeof data.label === "string" && data.label.trim()
        ? data.label.trim()
        : "선택한 지점";

    if (scheduledSeekTimeoutId) {
      clearTimeout(scheduledSeekTimeoutId);
      scheduledSeekTimeoutId = null;
    }

    const serverNow = Date.now() / 1000;
    const startAtServerTime = serverNow + 3;
    const delayMs = Math.max(0, Math.round((startAtServerTime - serverNow) * 1000));

    io.emit("sync", {
      forceSeek: true,
      playing: state.playing,
      currentTime: t,
      startAtServerTime,
      serverNow,
      seekLabel: label,
    });

    scheduledSeekTimeoutId = setTimeout(() => {
      scheduledSeekTimeoutId = null;
      setSeekAt(t);
      io.emit("time", {
        currentTime: getCurrentTime(),
        clients: io.sockets.sockets.size,
      });
    }, delayMs);

    console.log("[SYNC][SCHEDULE_SEEK]", {
      currentTime: t,
      playing: state.playing,
      startAtServerTime,
      sender: socket.id,
      clients: io.sockets.sockets.size,
    });
  });

  socket.on("disconnect", () => {
    if (isAdminSocket(socket)) {
      clearAdmin("disconnect");
    }
    viewerSlotsBySocketId.delete(socket.id);
    scheduleSync();
  });

  scheduleSync();
});

scheduleSync();

httpServer.listen(PORT, () => {
  console.log("Video Player for Museum - broadcast sync server");
  console.log("http://localhost:" + PORT);
  console.log("ADMIN_KEY env is required for production.");
  console.log("MEDIA_BASE_URL:", MEDIA_BASE_URL || "(not set)");
  console.log("MEDIA_PREFIX:", MEDIA_PREFIX || "(root)");
  console.log("VIDEO_SLOTS:", getConfiguredVideoSlots().join(", "));
});
