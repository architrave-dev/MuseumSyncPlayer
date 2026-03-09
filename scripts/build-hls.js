const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const SOURCE_DIR = path.join(ROOT_DIR, "asset");
const OUTPUT_DIR = path.join(ROOT_DIR, "asset-hls");
const PLAYLIST_PATH = path.join(OUTPUT_DIR, "playlist.m3u8");

const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;

function getSourceVideoPath() {
  if (!fs.existsSync(SOURCE_DIR)) {
    throw new Error("asset 폴더가 없습니다.");
  }

  const names = fs.readdirSync(SOURCE_DIR);
  const file = names.find((name) => VIDEO_EXT.test(name));

  if (!file) {
    throw new Error("asset 폴더에 원본 영상 파일이 없습니다.");
  }

  return path.join(SOURCE_DIR, file);
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
  const sourceVideoPath = getSourceVideoPath();
  ensureCleanOutputDir();

  console.log("HLS 인코딩 시작:", path.basename(sourceVideoPath));

  const ffmpegArgs = [
    "-y",
    "-i",
    sourceVideoPath,
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
    path.join(OUTPUT_DIR, "segment_%03d.ts"),
    PLAYLIST_PATH,
  ];

  await runFfmpeg(ffmpegArgs);

  console.log("HLS 인코딩 완료:", PLAYLIST_PATH);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
