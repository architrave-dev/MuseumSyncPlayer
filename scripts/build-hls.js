const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const SOURCE_DIR = path.join(ROOT_DIR, "asset");
const OUTPUT_DIR = path.join(ROOT_DIR, "asset-hls");
const MAX_VIDEO_COUNT = 8;

const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;

function getSourceVideoPaths() {
  if (!fs.existsSync(SOURCE_DIR)) {
    throw new Error("asset 폴더가 없습니다.");
  }

  const names = fs
    .readdirSync(SOURCE_DIR)
    .filter((name) => VIDEO_EXT.test(name))
    .sort((a, b) => a.localeCompare(b, "ko"));

  if (names.length === 0) {
    throw new Error("asset 폴더에 원본 영상 파일이 없습니다.");
  }

  return names.slice(0, MAX_VIDEO_COUNT).map((name) => ({
    name,
    sourcePath: path.join(SOURCE_DIR, name),
  }));
}

function ensureCleanOutputDir() {
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, {
      cwd: ROOT_DIR,
      stdio: "inherit",
    });

    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(
          new Error(
            "ffmpeg를 찾을 수 없습니다. ffmpeg 설치 후 다시 시도해 주세요.",
          ),
        );
        return;
      }

      reject(err);
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error("ffmpeg가 비정상 종료되었습니다. exit code=" + code));
    });
  });
}

async function main() {
  const sourceVideos = getSourceVideoPaths();
  ensureCleanOutputDir();

  console.log("HLS 인코딩 대상 수:", sourceVideos.length);

  for (let index = 0; index < sourceVideos.length; index += 1) {
    const slot = index + 1;
    const sourceVideo = sourceVideos[index];
    const slotDir = path.join(OUTPUT_DIR, String(slot));
    const playlistPath = path.join(slotDir, "playlist.m3u8");

    fs.mkdirSync(slotDir, { recursive: true });
    console.log("HLS 인코딩 시작:", slot + "번", sourceVideo.name);

    const ffmpegArgs = [
      "-y",
      "-i",
      sourceVideo.sourcePath,
      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-profile:v",
      "main",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "48000",
      "-g",
      "48",
      "-keyint_min",
      "48",
      "-sc_threshold",
      "0",
      "-f",
      "hls",
      "-hls_time",
      "4",
      "-hls_playlist_type",
      "vod",
      "-hls_segment_filename",
      path.join(slotDir, "segment_%03d.ts"),
      playlistPath,
    ];

    await runFfmpeg(ffmpegArgs);
    console.log("HLS 인코딩 완료:", slot + "번", playlistPath);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
