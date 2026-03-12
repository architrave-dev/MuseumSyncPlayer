(function () {
  "use strict";

  var isMobileDevice =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent,
    );
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  if (isMobileDevice) {
    document.body.classList.add("is-mobile");
  }
  var mobiletag = document.querySelector(".title-mobile-tag");
  if (mobiletag) {
    mobiletag.textContent = isIOS ? "ios" : "m";
  }

  var video = document.getElementById("video");
  var videoWrap = document.getElementById("videoWrap");
  var statusEl = document.getElementById("status");
  var connectionDot = document.getElementById("connectionDot");
  var playbackLabel = document.getElementById("playbackLabel");
  var fullscreenBtn = document.getElementById("fullscreenBtn");
  var volumeBtn = document.getElementById("volumeBtn");
  var logConsoleBody = document.getElementById("logConsoleBody");
  var logConsoleHeader = document.querySelector(".log-console-header");
  var btnRestart = document.getElementById("btnRestart");
  var centerPlay = document.getElementById("centerPlay");
  var centerPause = document.getElementById("centerPause");
  var centerControls = document.getElementById("centerControls");
  var viewerTapOverlay = document.getElementById("viewerTapOverlay");
  var videoTimeDisplay = document.getElementById("videoTimeDisplay");

  var params = new URLSearchParams(window.location.search || "");
  var adminKey = params.get("adminKey") || "";

  if (adminKey) {
    try {
      params.delete("adminKey");
      var nextQuery = params.toString();
      var nextUrl =
        window.location.pathname +
        (nextQuery ? "?" + nextQuery : "") +
        window.location.hash;
      window.history.replaceState(window.history.state, "", nextUrl);
    } catch (e) {}
  }

  var socket = io({
    auth: {
      adminKey: adminKey,
    },
  });

  var role = "viewer";
  var isAdmin = false;
  var hasRoleAssigned = false;
  var hasInitializedVideoSelection = false;
  var availableVideos = null;
  var selectedVideoSlot = 1;

  var MAX_LOG_LINES = 40;
  var lastSyncPlaying = null;

  var SYNC_CFG = {
    smallDiff: 0.25,            // 250ms 이내는 같은 시점으로 봄
    largeJumpDiff: 5.0,         // catch-up 프로필 상한
    aggressiveDiffThreshold: 0.8, // 이 이상이면 catch-up 프로필 사용
    residualAlpha: 0.2,         // diff EMA 계수

    diffBands: [
      { max: 0.5, gain: 0.5, maxDelta: 0.15 },
      { max: 1.5, gain: 1.0, maxDelta: 0.25 },
      { max: Infinity, gain: 1.4, maxDelta: 0.3 },
    ],

    rateMin: 0.8,
    rateMax: 1.2,
    maxStepPerChange: 0.1,
    minHoldMs: 8000,

    catchupMaxStepPerChange: 0.1,
    catchupMinHoldMs: 3000,

    mobileMaxStepPerChange: 0.1,
    mobileMinHoldMs: 4500,
    mobileCatchupMinHoldMs: 3500,
  };

  // 싱크 상태 추정용 변수들
  var syncDiffEma = null;
  var lastSyncPlaybackRate = 1.0;
  var lastRateChangeTimeMs = 0;

  var lastAppliedRateLog = null;
  var heartbeatTimerId = null;

  var needsManualStart = false;
  var endedSyncRequestTimerId = null;
  var hasLoggedVideoReady = false;
  var hasLoggedCanPlay = false;
  var lastLoggedBufferAheadSec = 0;
  var connectionState = "connecting";
  var videoLoadState = "idle";
  var statusOverrideText = "";
  var hlsPlayer = null;
  /** iOS stall 복구 마지막 시도 시각 (ms) */
  var iosStallRecoveryLastMs = 0;
  /** iOS stall 감지용: 직전 time 이벤트의 local/server 시각 */
  var iosPrevLocalT = null;
  var iosPrevServerT = null;
  /** viewer 전용: 최초 1회 탭으로 재생 허용했는지 */
  var viewerPlaybackAllowed = false;
  /** viewer 전용: 재생 허용 후 admin '처음부터' 클릭 대기. 해제되면 이후 속도조절만 사용 */
  var waitingForAdminRestart = false;
  /** 서버 시각 = 로컬 시각 - serverTimeOffset (초). null이면 아직 동기화 전 */
  var serverTimeOffset = null;
  /** 예약 재생: 카운트다운용 setInterval id */
  var scheduledStartTimerId = null;
  /** 예약 재생: 정확한 시각에 재생하기 위한 setTimeout id */
  var scheduledPlayTimeoutId = null;

  setInterval(function () {
    if (logConsoleHeader && video) {
      var speed =
        typeof video.playbackRate === "number"
          ? video.playbackRate.toFixed(2)
          : "-";
      logConsoleHeader.textContent = "진단 로그 · 현재 속도: " + speed;
    }
  }, 1500);

  function appendLog(text) {
    if (!logConsoleBody) return;

    var now = new Date();
    var hh = String(now.getHours()).padStart(2, "0");
    var mm = String(now.getMinutes()).padStart(2, "0");
    var ss = String(now.getSeconds()).padStart(2, "0");
    var ts = hh + ":" + mm + ":" + ss;

    var lineEl = document.createElement("div");
    lineEl.className = "log-line";
    lineEl.textContent = "[" + ts + "] " + text;
    logConsoleBody.appendChild(lineEl);

    while (logConsoleBody.children.length > MAX_LOG_LINES) {
      logConsoleBody.removeChild(logConsoleBody.firstChild);
    }
    logConsoleBody.scrollTop = logConsoleBody.scrollHeight;
  }

  window.appendDiagnosticLog = appendLog;

  function getRoleStatusText() {
    if (isAdmin) {
      return "admin 모드 · 1번 영상을 제어합니다";
    }
    return "viewer 모드 · " + selectedVideoSlot + "번 영상을 재생합니다";
  }

  function getVideoLoadStatusText() {
    if (videoLoadState === "loading") return "버퍼 준비중...";
    if (videoLoadState === "ready") return "재생 가능...";
    return "";
  }

  function renderStatus() {
    if (!statusEl) return;

    if (statusOverrideText) {
      statusEl.textContent = statusOverrideText;
      return;
    }

    if (connectionState === "disconnected") {
      statusEl.textContent = "연결 끊김 · 서버 재연결 대기 중";
      return;
    }

    if (connectionState !== "connected") {
      statusEl.textContent = "서버 연결 대기 중";
      return;
    }

    var parts = ["연결됨"];
    var loadStatusText = getVideoLoadStatusText();
    if (loadStatusText) parts.push(loadStatusText);
    parts.push(getRoleStatusText());
    statusEl.textContent = parts.join(" · ");
  }

  function setStatus(text) {
    statusOverrideText = text || "";
    renderStatus();
  }

  function clearStatusOverride() {
    if (!statusOverrideText) return;
    statusOverrideText = "";
    renderStatus();
  }

  function setVideoLoadState(nextState) {
    videoLoadState = nextState;
    renderStatus();
  }

  function resetVideoLoadDiagnostics() {
    hasLoggedVideoReady = false;
    hasLoggedCanPlay = false;
    lastLoggedBufferAheadSec = 0;
  }

  function getVideoEntryBySlot(slot) {
    if (!availableVideos || !availableVideos.length) return null;
    for (var i = 0; i < availableVideos.length; i++) {
      if (availableVideos[i].slot === slot) return availableVideos[i];
    }
    return null;
  }

  function getAvailableSlotNumbers() {
    if (!availableVideos || !availableVideos.length) return [];
    return availableVideos.map(function (videoEntry) {
      return videoEntry.slot;
    });
  }

  function askViewerVideoSlot() {
    var slots = getAvailableSlotNumbers();
    if (!slots.length) return 1;

    var storedSlot = null;
    try {
      storedSlot = window.localStorage.getItem("viewerVideoSlot");
    } catch (e) {}

    var defaultSlot = slots.indexOf(Number(storedSlot)) >= 0 ? Number(storedSlot) : slots[0];
    var message =
      "몇 번 영상을 재생할까요?\n" +
      "사용 가능한 번호: " +
      slots.join(", ");

    while (true) {
      var input = window.prompt(message, String(defaultSlot));
      var nextSlot = input === null || input.trim() === "" ? defaultSlot : Number(input);
      if (slots.indexOf(nextSlot) >= 0) {
        try {
          window.localStorage.setItem("viewerVideoSlot", String(nextSlot));
        } catch (e) {}
        return nextSlot;
      }
      window.alert("사용 가능한 영상 번호를 입력해 주세요: " + slots.join(", "));
    }
  }

  function loadSelectedVideoEntry(videoEntry) {
    if (!videoEntry || !videoEntry.url) {
      setStatus("선택한 영상을 불러오지 못했습니다. S3 HLS 설정을 확인해 주세요.");
      return;
    }

    if (videoWrap) videoWrap.classList.add("is-loading");
    resetVideoLoadDiagnostics();
    setVideoLoadState("loading");
    renderStatus();

    function hideLoading() {
      if (videoWrap) videoWrap.classList.remove("is-loading");
    }

    function requestSync() {
      socket.emit("getState");
      if (isAdmin && adminKey) socket.emit("requestAdmin", { adminKey: adminKey });
    }

    loadVideoSource(videoEntry.url);
    appendLog("선택된 영상: " + videoEntry.slot + "번");

    video.addEventListener("canplay", hideLoading, { once: true });

    if (video.readyState >= 2) hideLoading();

    if (video.readyState >= 1) requestSync();
    else {
      video.addEventListener("loadedmetadata", requestSync, { once: true });
    }
  }

  function initializeVideoSelectionIfReady() {
    if (hasInitializedVideoSelection) return;
    if (!hasRoleAssigned || !availableVideos || !availableVideos.length) return;

    if (isAdmin) {
      selectedVideoSlot = getVideoEntryBySlot(1) ? 1 : availableVideos[0].slot;
    } else {
      selectedVideoSlot = askViewerVideoSlot();
    }

    hasInitializedVideoSelection = true;
    renderStatus();
    loadSelectedVideoEntry(getVideoEntryBySlot(selectedVideoSlot));
  }

  function destroyHlsPlayer() {
    if (!hlsPlayer) return;
    hlsPlayer.destroy();
    hlsPlayer = null;
  }

  function loadVideoSource(url) {
    destroyHlsPlayer();
    appendLog("HLS 스트림 로드 시작");

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      video.load();
      appendLog("네이티브 HLS 로드");
      return;
    }

    if (window.Hls && window.Hls.isSupported()) {
      hlsPlayer = new window.Hls({
        enableWorker: true,
        backBufferLength: 90,
      });
      hlsPlayer.loadSource(url);
      hlsPlayer.attachMedia(video);
      hlsPlayer.on(window.Hls.Events.MANIFEST_PARSED, function (_event, data) {
        var levelCount = data && data.levels ? data.levels.length : 0;
        appendLog(
          "HLS 매니페스트 로드 완료" +
            (levelCount > 0 ? " (" + levelCount + "개 레벨)" : ""),
        );
      });
      hlsPlayer.on(window.Hls.Events.ERROR, function (_event, data) {
        if (data && data.fatal) {
          appendLog("HLS 치명적 오류: " + data.type);
          setStatus("HLS 재생 오류 · 스트림을 확인해 주세요.");
        }
      });
      return;
    }

    setStatus("이 브라우저는 HLS 재생을 지원하지 않습니다.");
  }

  function getBufferedAheadSeconds() {
    if (!video || !video.buffered || video.buffered.length === 0) return 0;

    var current = video.currentTime || 0;
    for (var i = 0; i < video.buffered.length; i++) {
      var start = video.buffered.start(i);
      var end = video.buffered.end(i);
      if (current + 0.1 >= start && current <= end + 0.1) {
        return Math.max(0, end - current);
      }
      if (current < start) {
        return Math.max(0, end - start);
      }
    }

    return 0;
  }

  function logHlsBufferProgress() {
    if (!video || !video.src) return;

    var bufferedAheadSeconds = getBufferedAheadSeconds();
    if (bufferedAheadSeconds < 0.5) return;

    var roundedSec = Math.floor(bufferedAheadSeconds);
    if (roundedSec <= lastLoggedBufferAheadSec) return;
    if (lastLoggedBufferAheadSec !== 0 && roundedSec - lastLoggedBufferAheadSec < 2) return;

    lastLoggedBufferAheadSec = roundedSec;
    appendLog("HLS 버퍼 확보 " + bufferedAheadSeconds.toFixed(1) + "s");
  }

  function maybeMarkVideoReady() {
    if (hasLoggedVideoReady || !video || !video.src) return;

    var bufferedAheadSeconds = getBufferedAheadSeconds();
    var hasEnoughBuffer = bufferedAheadSeconds >= (isIOS ? 3 : 5);
    var nearEnd =
      isFinite(video.duration) &&
      video.duration > 0 &&
      bufferedAheadSeconds >= Math.max(0, video.duration - (video.currentTime || 0) - 0.25);

    if (video.readyState < 3 && !nearEnd) return;
    if (!hasEnoughBuffer && !nearEnd) return;

    hasLoggedVideoReady = true;
    setVideoLoadState("ready");
    appendLog(
      "준비 완료 · 재생 가능한 버퍼를 확보했습니다 (" +
        bufferedAheadSeconds.toFixed(1) +
        "s)",
    );
  }

  function setConnectionOnline(isOnline) {
    if (!connectionDot) return;
    connectionDot.classList.toggle("is-online", !!isOnline);
  }

  function setPlaybackLabel(isPlaying) {
    if (!playbackLabel) return;
    playbackLabel.textContent = isPlaying ? "재생중" : "정지";
  }

  function updatePlayStateClass() {
    if (!videoWrap) return;
    videoWrap.classList.remove("is-playing", "is-paused");
    videoWrap.classList.add(video.paused ? "is-paused" : "is-playing");
  }

  function resetSyncEstimators() {
    syncDiffEma = null;
    lastAppliedRateLog = null;
    lastRateChangeTimeMs = 0;
    lastSyncPlaybackRate = 1.0;
    if (video) video.playbackRate = 1.0;
    iosPrevLocalT = null;
    iosPrevServerT = null;
  }

  function showManualStartUi() {
    needsManualStart = true;

    if (isAdmin) {
      setStatus("재생 시작 실패 · 화면을 터치해 다시 시도해 주세요");
    } else {
      setStatus("자동 재생 대기 · 화면을 터치하여 재생을 허용해 주세요");
    }

    updateCenterButtonUi();
  }

  function showViewerTapOverlay() {
    if (!viewerTapOverlay) return;
    viewerTapOverlay.classList.add("is-visible");
    viewerTapOverlay.setAttribute("aria-hidden", "false");
  }

  function hideViewerTapOverlay() {
    if (!viewerTapOverlay) return;
    viewerTapOverlay.classList.remove("is-visible");
    viewerTapOverlay.setAttribute("aria-hidden", "true");
  }

  function clearManualStartUi() {
    if (!needsManualStart) return;
    needsManualStart = false;

    if (socket && socket.connected) {
      clearStatusOverride();
    }

    updateCenterButtonUi();
  }

  function safePlay(reason) {
    return video.play().catch(function (err) {
      // AbortError = 다른 play()/pause() 호출이 이 play()를 중단시킨 것.
      // 실제 실패가 아니므로 UI 건드리지 않고 무시
      if (err && err.name === "AbortError") {
        appendLog("play 중단 (AbortError) · 다른 명령으로 대체됨");
        return;
      }
      appendLog(
        "play 실패" +
          (reason ? " [" + reason + "]" : "") +
          (err && err.message ? ": " + err.message : ""),
      );
      showManualStartUi();
      if (!isAdmin) {
        viewerPlaybackAllowed = false;
        showViewerTapOverlay();
      }
    });
  }

  function isFullscreen() {
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.msFullscreenElement
    );
  }

  function enterFullscreen() {
    if (video && video.webkitEnterFullscreen) {
      try {
        video.webkitEnterFullscreen();
        return;
      } catch (e) {}
    }

    var target = videoWrap || video;
    if (!target) return;

    if (target.requestFullscreen) {
      target.requestFullscreen();
    } else if (target.webkitRequestFullscreen) {
      target.webkitRequestFullscreen();
    } else if (target.msRequestFullscreen) {
      target.msRequestFullscreen();
    }
  }

  function exitFullscreen() {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    } else if (document.msExitFullscreen) {
      document.msExitFullscreen();
    }
  }

  function toggleFullscreen() {
    if (isFullscreen()) exitFullscreen();
    else enterFullscreen();
    updateFullscreenUi();
  }

  function updateFullscreenUi() {
    if (!fullscreenBtn) return;
    var fs = !!isFullscreen();
    fullscreenBtn.classList.toggle("is-fullscreen", fs);
    fullscreenBtn.textContent = fs ? "✕" : "⛶";
    fullscreenBtn.setAttribute(
      "aria-label",
      fs ? "전체 화면 종료" : "전체 화면",
    );
  }

  function updateVolumeUi() {
    if (!volumeBtn) return;
    var muted = !!video.muted;
    volumeBtn.textContent = muted ? "🔇" : "🔊";
    volumeBtn.setAttribute("aria-label", muted ? "소리 켜기" : "소리 끄기");
  }

  function stopHeartbeat() {
    if (heartbeatTimerId) {
      clearInterval(heartbeatTimerId);
      heartbeatTimerId = null;
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimerId = setInterval(function () {
      if (socket && socket.connected && isAdmin) {
        socket.emit("heartbeat", { t: Date.now() });
      }
    }, 2000);
  }

  function updateCenterButtonUi() {
    if (!centerPlay || !centerPause || !centerControls) return;

    if (isAdmin) {
      centerControls.style.display = "";
      // admin 모드에서는 CSS의 재생 상태 클래스(`is-paused` / `is-playing`)에 따라
      // 어떤 버튼을 보여줄지 결정하도록 맡긴다.
      // 여기서는 텍스트/접근성 라벨만 설정한다.
      centerPause.style.display = "";
      centerPlay.style.display = "";
      centerPlay.textContent = "▶";
      centerPause.textContent = "⏸";
      centerPlay.setAttribute("aria-label", "재생");
      centerPause.setAttribute("aria-label", "정지");
      return;
    }

    // viewer 모드에서는 가운데 버튼을 사용하지 않는다.
    centerControls.style.display = "none";
  }

  function applyRole(newRole) {
    role = newRole === "admin" ? "admin" : "viewer";
    isAdmin = role === "admin";

    if (videoWrap) videoWrap.classList.toggle("is-admin", isAdmin);
    if (!isAdmin && btnRestart) btnRestart.style.display = "none";
    if (isAdmin && btnRestart) btnRestart.style.display = "";

    if (isAdmin) {
      hideViewerTapOverlay();
      waitingForAdminRestart = false;
      startHeartbeat();
    } else {
      stopHeartbeat();
    }

    renderStatus();
    setupCenterControls();
    updateVolumeUi();
    updateCenterButtonUi();
  }

  function setupCenterControls() {
    if (!centerPlay || !centerPause) return;

    centerPlay.replaceWith(centerPlay.cloneNode(true));
    centerPause.replaceWith(centerPause.cloneNode(true));
    centerPlay = document.getElementById("centerPlay");
    centerPause = document.getElementById("centerPause");

    if (isAdmin) {
      updateCenterButtonUi();

      centerPlay.addEventListener("click", function () {
        playFromCurrent();
      });
      centerPause.addEventListener("click", function () {
        pauseAtCurrent();
      });
      return;
    }
    // viewer 모드에서는 중앙 버튼을 사용하지 않는다.
    if (centerControls) {
      centerControls.style.display = "none";
    }
  }

  function applySync(data) {
    if (!video.src) return;

    var t = typeof data.currentTime === "number" ? data.currentTime : 0;
    if (t < 0) t = 0;

    if (!isAdmin && !viewerPlaybackAllowed) {
      showViewerTapOverlay();
      updatePlayStateClass();
      setPlaybackLabel(false);
      if (typeof data.playing === "boolean") {
        if (lastSyncPlaying === null || lastSyncPlaying !== data.playing) {
          appendLog("sync 수신 · 화면을 터치하여 재생 허용");
        }
        lastSyncPlaying = data.playing;
      }
      return;
    }

    if (!isAdmin && viewerPlaybackAllowed && waitingForAdminRestart) {
      if (data.playing && t < 0.5) {
        waitingForAdminRestart = false;
        clearStatusOverride();
        appendLog("admin 처음부터 재생 수신 · 0초부터 속도조절 싱크 시작");
      } else {
        setStatus("재생 허용됨 · admin이 '처음부터'를 누를 때까지 대기");
      }
      if (data.playing) {
        if (
          typeof data.startAtServerTime === "number" &&
          data.startAtServerTime > 0
        ) {
          schedulePlayAtServerTime(data.startAtServerTime, data.serverNow, t);
        } else {
          safePlay("sync");
        }
      } else {
        clearScheduledStart();
        video.pause();
        resetSyncEstimators();
      }
      updatePlayStateClass();
      setPlaybackLabel(!!data.playing);
      if (typeof data.playing === "boolean") {
        if (lastSyncPlaying === null || lastSyncPlaying !== data.playing) {
          appendLog(
            "sync " +
              (data.playing ? "재생" : "정지") +
              " 수신 (t=" +
              t.toFixed(3) +
              "s)",
          );
        }
        lastSyncPlaying = data.playing;
      }
      return;
    }

    if (data.playing) {
      if (
        typeof data.startAtServerTime === "number" &&
        data.startAtServerTime > 0
      ) {
        schedulePlayAtServerTime(data.startAtServerTime, data.serverNow, t);
      } else {
        safePlay("sync");
      }
    } else {
      clearScheduledStart();
      video.pause();
      resetSyncEstimators();
    }

    updatePlayStateClass();
    setPlaybackLabel(!!data.playing);

    if (typeof data.playing === "boolean") {
      if (lastSyncPlaying === null || lastSyncPlaying !== data.playing) {
        appendLog(
          "sync " +
            (data.playing ? "재생" : "정지") +
            " 수신 (t=" +
            t.toFixed(3) +
            "s)",
        );
      }
      lastSyncPlaying = data.playing;
    }
  }

  function clearScheduledStart() {
    if (scheduledStartTimerId) {
      clearInterval(scheduledStartTimerId);
      scheduledStartTimerId = null;
    }
    if (scheduledPlayTimeoutId) {
      clearTimeout(scheduledPlayTimeoutId);
      scheduledPlayTimeoutId = null;
    }
  }

  function schedulePlayAtServerTime(startAtServerTime, serverNow, currentTime) {
    clearScheduledStart();
    var nowMs = Date.now();
    var nowSec = nowMs / 1000;
    var offset =
      serverTimeOffset != null
        ? serverTimeOffset
        : serverNow != null
          ? nowSec - serverNow
          : 0;
    var localStartMs = (startAtServerTime + offset) * 1000;
    var delayMs = localStartMs - nowMs;

    if (delayMs <= 0) {
      if (!isIOS && typeof currentTime === "number" && currentTime >= 0) {
        video.currentTime = currentTime;
      }
      safePlay("scheduled_start");
      updatePlayStateClass();
      setPlaybackLabel(true);
      return;
    }

    if (isIOS) {
      // iOS WARM-DECODER 전략
      // ─────────────────────────────────────────────────────────────────
      // 문제: pause() 후 play() = VideoToolbox cold-start = 0~50초 랜덤 지연
      // 해결: 카운트다운 동안 pause 없이 재생 유지(warm decoder 상태 보존).
      //       예약 시각에 도달하면 seek-while-playing(warm seek)으로 위치 조정.
      //       warm seek 지연 ≈ 300ms (일관됨) vs cold-start 지연 = 0~50초 (랜덤)
      // iOS 10+: muted+playsinline 영상은 제스처 없이 play() 가능
      // ─────────────────────────────────────────────────────────────────

      // warm decoder 실험용 비활성화:
      // 카운트다운 중 실제 재생이 발생해 UX가 어색해서 일단 주석 처리.
      // 필요하면 아래 코드를 다시 활성화해 iOS cold-start 지연과 비교할 수 있다.
      // if (video.paused) {
      //   safePlay("ios_warmup");
      //   appendLog("iOS decoder 웜업 시작");
      // }
      video.pause();

      var initialSecIOS = Math.ceil(delayMs / 1000);
      appendLog(
        "iOS 예약 시작 " + initialSecIOS + "초 후 (서버 시각 " + startAtServerTime.toFixed(1) + "s)",
      );

      var iosLastLoggedSec = null;
      scheduledStartTimerId = setInterval(function () {
        var remainingMs = localStartMs - Date.now();
        var remainingSec = remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
        if (remainingSec !== iosLastLoggedSec) {
          iosLastLoggedSec = remainingSec;
          if (remainingSec > 0) appendLog(remainingSec + "초 남음");
        }
        if (remainingMs <= 0) {
          clearInterval(scheduledStartTimerId);
          scheduledStartTimerId = null;
        }
      }, 1000);

      scheduledPlayTimeoutId = setTimeout(function () {
        scheduledPlayTimeoutId = null;
        clearScheduledStart();
        updatePlayStateClass();
        setPlaybackLabel(true);

        var targetTime = typeof currentTime === "number" && currentTime >= 0 ? currentTime : 0;
        appendLog("iOS 예약 시작 실행 (서버 시각 " + startAtServerTime.toFixed(1) + "s)");

        // warm seek 실험용 비활성화:
        // 재생 중 seek 대신 예약 시각까지 pause 유지 후 seek + play만 수행한다.
        // if (!video.paused && Math.abs(video.currentTime - targetTime) > 0.1) {
        //   appendLog("iOS warm seek: " + video.currentTime.toFixed(2) + "s → " + targetTime.toFixed(2) + "s");
        //   video.currentTime = targetTime;
        //   video.addEventListener("seeked", function () {
        //     iosPrevLocalT = null;
        //     iosPrevServerT = null;
        //     safePlay("ios_warm_seek_done");
        //   }, { once: true });
        // } else if (video.paused) {
        //   video.currentTime = targetTime;
        //   safePlay("ios_scheduled_start");
        // }
        video.currentTime = targetTime;
        iosPrevLocalT = null;
        iosPrevServerT = null;
        safePlay("ios_scheduled_start");
      }, delayMs);

      return;
    }

    // Non-iOS 경로
    if (typeof currentTime === "number" && currentTime >= 0) {
      video.currentTime = currentTime;
    }
    video.pause();

    var lastLoggedSec = null;
    scheduledStartTimerId = setInterval(function () {
      var remainingMs = localStartMs - Date.now();
      var remainingSec = remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
      if (remainingSec <= 0) {
        clearScheduledStart();
        safePlay("scheduled_start");
        updatePlayStateClass();
        setPlaybackLabel(true);
        appendLog(
          "예약 시작 실행 (서버 시각 " + startAtServerTime.toFixed(1) + "s)",
        );
        return;
      }
      if (remainingSec !== lastLoggedSec) {
        lastLoggedSec = remainingSec;
        appendLog(remainingSec + "초 남음");
        if (remainingSec === 1) {
          scheduledPlayTimeoutId = setTimeout(
            function () {
              scheduledPlayTimeoutId = null;
              clearScheduledStart();
              safePlay("scheduled_start");
              updatePlayStateClass();
              setPlaybackLabel(true);
              appendLog(
                "예약 시작 실행 (서버 시각 " +
                  startAtServerTime.toFixed(1) +
                  "s)",
              );
            },
            Math.max(0, remainingMs),
          );
        }
      }
    }, 1000);
    var initialSec = Math.ceil(delayMs / 1000);
    appendLog(
      "예약 시작 " +
        initialSec +
        "초 후 (서버 시각 " +
        startAtServerTime.toFixed(1) +
        "s)",
    );
  }

  socket.on("connect", function () {
    connectionState = "connected";
    setConnectionOnline(true);
    renderStatus();
    appendLog("서버에 연결되었습니다.");
    socket.emit("getServerTime", { clientSend: Date.now() }, function (res) {
      if (res && typeof res.serverTime === "number") {
        var clientRecv = Date.now();
        var rtt = 0;
        if (typeof res.clientSend === "number") {
          rtt = clientRecv - res.clientSend;
        }
        serverTimeOffset = clientRecv / 1000 - res.serverTime - rtt / 2000;
      }
    });
  });

  socket.on("disconnect", function () {
    connectionState = "disconnected";
    statusOverrideText = "";
    setConnectionOnline(false);
    stopHeartbeat();
    clearScheduledStart();
    renderStatus();
    appendLog("서버와 연결이 끊어졌습니다.");
  });

  socket.on("roleAssigned", function (data) {
    applyRole(data && data.role ? data.role : "viewer");
    hasRoleAssigned = true;
    initializeVideoSelectionIfReady();
    appendLog("role assigned: " + role);
  });

  socket.on("adminDenied", function (data) {
    var reason =
      data && data.reason ? data.reason : "admin 요청이 거절되었습니다.";
    applyRole("viewer");
    appendLog("admin denied: " + reason);
  });

  socket.on("adminVacant", function () {
    appendLog("admin 슬롯이 비었습니다.");
    if (adminKey) {
      appendLog("adminKey가 있으므로 admin 재요청");
      socket.emit("requestAdmin", { adminKey: adminKey });
    }
  });

  socket.on("notAuthorized", function (data) {
    appendLog("권한 없음: " + (data && data.action ? data.action : "unknown"));
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && video.src) {
      socket.emit("getState");
    }
  });

  socket.on("state", function (data) {
    applySync(data);
  });

  socket.on("sync", function (data) {
    applySync(data);
  });

  function setupVolumeControl() {
    if (!volumeBtn) return;

    video.muted = true;
    updateVolumeUi();

    volumeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      video.muted = !video.muted;
      updateVolumeUi();
    });

    video.addEventListener("volumechange", function () {
      updateVolumeUi();
    });
  }

  function setupViewerTapOverlay() {
    if (!viewerTapOverlay) return;

    viewerTapOverlay.addEventListener("click", function (e) {
      e.stopPropagation();
      if (isAdmin) return;
      hideViewerTapOverlay();
      waitingForAdminRestart = true;
      socket.emit("getState");
      safePlay("manual_start");
    });
  }

  socket.on("time", function (data) {
    if (!video.src || typeof data.currentTime !== "number") return;
    if (!isAdmin && !viewerPlaybackAllowed) return;
    if (!isAdmin && waitingForAdminRestart) return;

    var serverT = data.currentTime;
    var localT = video.currentTime || 0;
    var rawDiff = serverT - localT;
    var isPaused = video.paused;
    var nowMs = Date.now();

    // iOS도 이제 seek 없이 playbackRate 보정을 시도한다.
    // 기존 stall 감지는 유지해서 rate 변경으로 인한 멈춤이 생기면 복구한다.
    if (isIOS) {
      if (!scheduledPlayTimeoutId && !scheduledStartTimerId) {
        // Stall 감지: play() 중에 currentTime이 진행되지 않는 경우 (위치 무관)
        // 직전 이벤트 대비 local이 거의 안 움직였는데 server는 진행됐으면 stall
        if (!video.paused && !video.seeking) {
          if (
            iosPrevLocalT !== null &&
            Math.abs(localT - iosPrevLocalT) < 0.05 &&
            serverT - iosPrevServerT > 1.5
          ) {
            var iosNowMs = Date.now();
            if (iosNowMs - iosStallRecoveryLastMs > 4000) {
              iosStallRecoveryLastMs = iosNowMs;
              appendLog("iOS stall (t=" + localT.toFixed(2) + "s) · pause→play 재시도");
              video.pause();
              setTimeout(function () { safePlay("ios_stall_retry"); }, 300);
            }
          }
          iosPrevLocalT = localT;
          iosPrevServerT = serverT;
        }
      }
    }

    if (isPaused) {
      updatePlayStateClass();
      return;
    }

    // diff = 서버 시간 − 로컬 시간 (단위: 초). 양수=느림, 음수=빠름
    // 속도 변경 시 video.currentTime이 끊김으로 튀므로, 판단/보정은 EMA로 스무딩한 값 사용 (느린데 빠르다고 하지 않도록)
    if (syncDiffEma === null) syncDiffEma = rawDiff;
    else
      syncDiffEma =
        syncDiffEma * (1 - SYNC_CFG.residualAlpha) +
        rawDiff * SYNC_CFG.residualAlpha;
    var diff = syncDiffEma;

    appendLog(
      "diff=" +
        diff.toFixed(3) +
        "s (raw=" +
        rawDiff.toFixed(3) +
        "s) (server=" +
        serverT.toFixed(2) +
        "s local=" +
        localT.toFixed(2) +
        "s)",
    );

    var SMALL_DIFF = SYNC_CFG.smallDiff;
    var LARGE_JUMP_DIFF = SYNC_CFG.largeJumpDiff;

    if (Math.abs(diff) <= SMALL_DIFF) {
      video.playbackRate = 1.0;
      lastSyncPlaybackRate = 1.0;
      return;
    }

    var absDiff = Math.abs(diff);
    var absRaw = Math.abs(rawDiff);
    var newRate;

    // 절대값 0.5초 이상~1초 이하: 0.9 / 1.1
    // 절대값 1초 이상: 0.8 / 1.2
    if (absDiff >= 1.0) {
      newRate = diff > 0 ? 1.2 : 0.8;
    } else if (absDiff >= 0.5) {
      newRate = diff > 0 ? 1.1 : 0.9;
    } else {
      // 그 외 구간은 기존 diffBands 기반 보정 사용
      var gain = 0;
      var maxDelta = 0;
      for (var i = 0; i < SYNC_CFG.diffBands.length; i++) {
        if (absDiff < SYNC_CFG.diffBands[i].max) {
          gain = SYNC_CFG.diffBands[i].gain;
          maxDelta = SYNC_CFG.diffBands[i].maxDelta;
          break;
        }
      }
      var rateOffset = Math.max(Math.min(diff * gain, maxDelta), -maxDelta);
      newRate = 1.0 + rateOffset;
    }

    // 항상 단계별 이동(점프 없음). 모바일은 스텝 더 작게·간격 더 두어 끊김 완화
    var maxStep = isMobileDevice
      ? SYNC_CFG.mobileMaxStepPerChange || 0.1
      : SYNC_CFG.maxStepPerChange;
    var minHoldMs = isMobileDevice
      ? SYNC_CFG.mobileMinHoldMs || 4500
      : SYNC_CFG.minHoldMs;

    if (
      absRaw >= SYNC_CFG.aggressiveDiffThreshold &&
      absRaw < LARGE_JUMP_DIFF
    ) {
      maxStep = isMobileDevice
        ? SYNC_CFG.mobileMaxStepPerChange || 0.1
        : SYNC_CFG.catchupMaxStepPerChange;
      minHoldMs = isMobileDevice
        ? SYNC_CFG.mobileCatchupMinHoldMs || 3500
        : SYNC_CFG.catchupMinHoldMs;
    }

    // 항상 전체 범위(0.8~1.2) 안에서만 동작
    var rateMin = SYNC_CFG.rateMin;
    var rateMax = SYNC_CFG.rateMax;

    var quantizedRate = Math.round(newRate * 10) / 10;
    quantizedRate = Math.max(Math.min(quantizedRate, rateMax), rateMin);

    var appliedRate = quantizedRate;
    if (appliedRate > lastSyncPlaybackRate + maxStep) {
      appliedRate = lastSyncPlaybackRate + maxStep;
    } else if (appliedRate < lastSyncPlaybackRate - maxStep) {
      appliedRate = lastSyncPlaybackRate - maxStep;
    }

    var canChangeRate =
      nowMs - lastRateChangeTimeMs >= minHoldMs || lastRateChangeTimeMs === 0;

    if (
      canChangeRate &&
      Math.abs(appliedRate - lastSyncPlaybackRate) >= 0.001
    ) {
      var rateToApply = appliedRate;
      if (isMobileDevice && typeof requestAnimationFrame === "function") {
        requestAnimationFrame(function () {
          if (video && !video.paused) video.playbackRate = rateToApply;
        });
      } else {
        video.playbackRate = rateToApply;
      }
      lastSyncPlaybackRate = rateToApply;
      lastRateChangeTimeMs = nowMs;

      if (lastAppliedRateLog !== rateToApply) {
        var lagSec = Math.abs(diff).toFixed(3);
        var msg =
          diff > 0
            ? lagSec + "초 느림: (" + rateToApply.toFixed(2) + ")"
            : lagSec + "초 빠름: (" + rateToApply.toFixed(2) + ")";
        appendLog(msg);
        lastAppliedRateLog = rateToApply;
      }
    }
  });

  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) return "0:00";
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ":" + String(s).padStart(2, "0");
  }

  function updateVideoTimeDisplay() {
    if (!videoTimeDisplay) return;
    var cur = video.currentTime;
    var dur =
      isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    videoTimeDisplay.textContent = formatTime(cur) + " / " + formatTime(dur);
  }

  video.addEventListener("loadedmetadata", function () {
    if (isFinite(video.duration) && video.duration > 0) {
      socket.emit("mediaReady", { duration: video.duration });
      appendLog("media ready (duration=" + video.duration.toFixed(3) + "s)");
    }
    updateVideoTimeDisplay();
    logHlsBufferProgress();
    maybeMarkVideoReady();
  });

  video.addEventListener("timeupdate", function () {
    updateVideoTimeDisplay();
  });

  video.addEventListener("progress", function () {
    logHlsBufferProgress();
    maybeMarkVideoReady();
  });
  video.addEventListener("canplay", function () {
    if (!hasLoggedCanPlay) {
      hasLoggedCanPlay = true;
      appendLog(
        "HLS canplay · 현재 버퍼 " +
          getBufferedAheadSeconds().toFixed(1) +
          "s",
      );
    }
    logHlsBufferProgress();
    maybeMarkVideoReady();
  });
  video.addEventListener("canplaythrough", maybeMarkVideoReady);

  video.addEventListener("play", function () {
    clearManualStartUi();
    updatePlayStateClass();
    setPlaybackLabel(true);
    if (!isAdmin) {
      viewerPlaybackAllowed = true;
      hideViewerTapOverlay();
    }
  });

  video.addEventListener("pause", function () {
    updatePlayStateClass();
    setPlaybackLabel(false);
  });

  video.addEventListener("ended", function () {
    resetSyncEstimators();
    updatePlayStateClass();
    setPlaybackLabel(false);

    if (isAdmin) {
      appendLog("로컬 ended 감지");
      return;
    }

    appendLog("viewer ended 감지 · 서버 state 재요청");

    if (endedSyncRequestTimerId) {
      clearTimeout(endedSyncRequestTimerId);
      endedSyncRequestTimerId = null;
    }

    endedSyncRequestTimerId = setTimeout(function () {
      socket.emit("getState");
      endedSyncRequestTimerId = null;
    }, 150);
  });

  function playFromCurrent() {
    if (!isAdmin) {
      appendLog("viewer 모드에서는 재생 제어 불가");
      return;
    }
    if (!video.src) {
      setStatus("영상을 불러오지 못했습니다. 서버를 확인해 주세요.");
      return;
    }

    resetSyncEstimators();
    socket.emit("play", { currentTime: video.currentTime });
    appendLog(
      "재생 요청 전송 · 서버 예약 시작 대기 (t=" +
        video.currentTime.toFixed(3) +
        "s)",
    );
  }

  function pauseAtCurrent() {
    if (!isAdmin) {
      appendLog("viewer 모드에서는 정지 제어 불가");
      return;
    }

    socket.emit("pause", { currentTime: video.currentTime });
    video.pause();
    resetSyncEstimators();
    updatePlayStateClass();
    setPlaybackLabel(false);
    appendLog("로컬 정지 (t=" + video.currentTime.toFixed(3) + "s)");
  }

  function restartFromZero() {
    if (!isAdmin) {
      appendLog("viewer 모드에서는 처음부터 제어 불가");
      return;
    }
    if (!video.src) {
      setStatus("영상을 불러오지 못했습니다. 서버를 확인해 주세요.");
      return;
    }

    resetSyncEstimators();
    video.currentTime = 0;
    socket.emit("play", { currentTime: 0 });
    appendLog("처음부터 요청 전송 · 서버 예약 시작 대기");
  }

  if (btnRestart) btnRestart.addEventListener("click", restartFromZero);

  if (fullscreenBtn) {
    fullscreenBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleFullscreen();
    });
  }

  updateFullscreenUi();
  updatePlayStateClass();
  setupCenterControls();
  setupVolumeControl();
  setupViewerTapOverlay();
  setVideoLoadState("loading");

  fetch("/api/videos")
    .then(function (res) {
      if (!res.ok) throw new Error("No videos");
      return res.json();
    })
    .then(function (data) {
      availableVideos = data && data.videos ? data.videos : [];
      if (!availableVideos.length) throw new Error("No videos");
      appendLog("사용 가능한 영상 번호: " + getAvailableSlotNumbers().join(", "));
      initializeVideoSelectionIfReady();
    })
    .catch(function () {
      setStatus("S3 HLS 구성을 확인해 주세요. 서버의 MEDIA_BASE_URL 설정이 필요합니다.");
    });
})();
