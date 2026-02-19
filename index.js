require('dotenv').config();

// Opt in to the updated file upload behavior in node-telegram-bot-api.
process.env.NTBA_FIX_350 = process.env.NTBA_FIX_350 || '1';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const TelegramBot = require('node-telegram-bot-api');
const ytDlp = require('yt-dlp-exec');

const TELEGRAM_VIDEO_LIMIT_BYTES = 50 * 1024 * 1024;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const TARGET_HEIGHT = Number.parseInt(process.env.TARGET_HEIGHT || '1080', 10);
const YTDLP_CONCURRENT_FRAGMENTS = Number.parseInt(process.env.YTDLP_CONCURRENT_FRAGMENTS || '8', 10);
const FFMPEG_PATH = (process.env.FFMPEG_PATH || '').trim();

if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();

if (!BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN in .env file');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on('polling_error', (error) => {
  console.error('[polling_error]', error?.response?.body || error?.message || error);

  if (error?.response?.statusCode === 404) {
    console.error('Telegram returned 404. Your bot token is invalid or revoked.');
  }
});

const YOUTUBE_URL_REGEX = /(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=[\w-]{11}[^\s]*|youtu\.be\/[\w-]{11}[^\s]*))/i;

function buildOutputPath(chatId, messageId) {
  return path.join(DOWNLOADS_DIR, `video_${chatId}_${messageId}_${Date.now()}.mp4`);
}

function extractYouTubeUrl(text) {
  if (!text) return null;
  const match = text.match(YOUTUBE_URL_REGEX);
  return match ? match[1] : null;
}

function safeDelete(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function cleanupByPrefix(prefixPath) {
  const base = path.basename(prefixPath);
  for (const name of fs.readdirSync(DOWNLOADS_DIR)) {
    if (name.startsWith(base)) {
      safeDelete(path.join(DOWNLOADS_DIR, name));
    }
  }
}

async function startCountdownStatus(chatId) {
  const cycleSeconds = 30;
  let remaining = cycleSeconds;
  let updating = false;

  const statusMsg = await bot.sendMessage(chatId, `Processing video... ${remaining}s`);
  const statusMessageId = statusMsg.message_id;

  const timer = setInterval(async () => {
    if (updating) return;
    updating = true;

    remaining -= 1;
    if (remaining <= 0) {
      remaining = cycleSeconds;
    }

    try {
      await bot.editMessageText(`Processing video... ${remaining}s`, {
        chat_id: chatId,
        message_id: statusMessageId
      });
    } catch (e) {
      // Ignore edit conflicts/rate errors so download flow is uninterrupted.
    } finally {
      updating = false;
    }
  }, 1000);

  return {
    async stop(finalText) {
      clearInterval(timer);
      try {
        await bot.editMessageText(finalText, {
          chat_id: chatId,
          message_id: statusMessageId
        });
      } catch (e) {
        // Ignore if message can no longer be edited.
      }
    }
  };
}

async function downloadProgressiveFallback(url, outputPath) {
  // Always download a single MP4 stream that already has both video and audio.
  // This avoids silent videos when ffmpeg merge is unavailable/broken.
  const progressiveFormat =
    `best[height<=${TARGET_HEIGHT}][ext=mp4][acodec!=none][vcodec!=none]/` +
    `best[ext=mp4][acodec!=none][vcodec!=none]`;

  const options = {
    format: progressiveFormat,
    output: outputPath,
    concurrentFragments: YTDLP_CONCURRENT_FRAGMENTS,
    noWarnings: true,
    noPlaylist: true
  };

  if (FFMPEG_PATH) {
    options.ffmpegLocation = FFMPEG_PATH;
  }

  return ytDlp(url, options);
}

function resolveFileByPrefix(prefixPath) {
  const dir = path.dirname(prefixPath);
  const base = path.basename(prefixPath);
  const matches = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(base))
    .filter((name) => !/\.part$/i.test(name))
    .sort((a, b) => {
      const aPath = path.join(dir, a);
      const bPath = path.join(dir, b);
      return fs.statSync(bPath).mtimeMs - fs.statSync(aPath).mtimeMs;
    });

  if (!matches.length) {
    return null;
  }

  return path.join(dir, matches[0]);
}

async function downloadSingleStream(url, format, prefixPath) {
  const options = {
    format,
    output: `${prefixPath}.%(ext)s`,
    concurrentFragments: YTDLP_CONCURRENT_FRAGMENTS,
    noWarnings: true,
    noPlaylist: true
  };

  if (FFMPEG_PATH) {
    options.ffmpegLocation = FFMPEG_PATH;
  }

  await ytDlp(url, options);
  const filePath = resolveFileByPrefix(prefixPath);
  if (!filePath) {
    throw new Error(`Stream output was not found for prefix: ${prefixPath}`);
  }
  return filePath;
}

function mergeWithFfmpeg(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpegBin = FFMPEG_PATH || 'ffmpeg';
    safeDelete(outputPath);

    const args = [
      '-y',
      '-i',
      videoPath,
      '-i',
      audioPath,
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      outputPath
    ];

    const proc = spawn(ffmpegBin, args, { windowsHide: true });
    let stderr = '';

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve();
        return;
      }
      reject(new Error(stderr || `ffmpeg exited with code ${code}`));
    });
  });
}

async function downloadHighQualityMerged(url, outputPath) {
  // Explicit HQ merge: best video <= target + best audio, then ffmpeg merge to MP4.
  const tempPrefix = `${outputPath}.hq_${Date.now()}`;
  const videoPrefix = `${tempPrefix}.video`;
  const audioPrefix = `${tempPrefix}.audio`;

  let videoPath = null;
  let audioPath = null;

  try {
    videoPath = await downloadSingleStream(
      url,
      `bestvideo[height<=${TARGET_HEIGHT}][vcodec!=none]`,
      videoPrefix
    );

    audioPath = await downloadSingleStream(
      url,
      'bestaudio[acodec!=none]',
      audioPrefix
    );

    await mergeWithFfmpeg(videoPath, audioPath, outputPath);
  } finally {
    cleanupByPrefix(videoPrefix);
    cleanupByPrefix(audioPrefix);
  }
}

async function runAndResolveFile(downloadFn, url, outputPath) {
  await downloadFn(url, outputPath);

  if (!fs.existsSync(outputPath)) {
    const dir = path.dirname(outputPath);
    const requestedBase = path.basename(outputPath, path.extname(outputPath));

    // yt-dlp may append/alter extension depending on the selected format.
    // Resolve the real file by prefix, preferring MP4.
    const matches = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(requestedBase))
      .filter((name) => !/\.part$/i.test(name))
      .filter((name) => /\.(mp4|mkv|webm|mov|m4v)$/i.test(name))
      .sort((a, b) => {
        const aPath = path.join(dir, a);
        const bPath = path.join(dir, b);
        return fs.statSync(bPath).mtimeMs - fs.statSync(aPath).mtimeMs;
      });

    if (!matches.length) {
      throw new Error('Download finished but output video file was not found.');
    }

    const cleanMp4 = matches.find((name) => /\.mp4$/i.test(name) && !/\.f\d+\./i.test(name));
    const cleanOther = matches.find((name) => !/\.f\d+\./i.test(name));

    if (!cleanMp4 && !cleanOther) {
      throw new Error('Only intermediate stream files were found after download.');
    }

    return path.join(dir, cleanMp4 || cleanOther);
  }

  return outputPath;
}

async function downloadVideo(url, outputPath) {
  try {
    const filePath = await runAndResolveFile(downloadHighQualityMerged, url, outputPath);
    return { filePath, usedFallback: false };
  } catch (error) {
    const message = String(error?.stderr || error?.message || error).toLowerCase();
    const looksLikeMergeIssue =
      message.includes('ffmpeg') ||
      message.includes('intermediate stream files') ||
      message.includes('stream output was not found');

    if (!looksLikeMergeIssue) {
      throw error;
    }

    const filePath = await runAndResolveFile(downloadProgressiveFallback, url, outputPath);
    return { filePath, usedFallback: true };
  }
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  const youtubeUrl = extractYouTubeUrl(text);
  if (!youtubeUrl) {
    return;
  }

  const outputPath = buildOutputPath(chatId, msg.message_id);
  let downloadedPath = null;
  let status = null;

  try {
    status = await startCountdownStatus(chatId);

    const result = await downloadVideo(youtubeUrl, outputPath);
    downloadedPath = result.filePath;
    if (result.usedFallback) {
      await bot.sendMessage(chatId, 'Sent fallback quality because ffmpeg merge was unavailable. Set FFMPEG_PATH in .env to enable high quality merge.');
    }

    const stats = fs.statSync(downloadedPath);
    if (stats.size > TELEGRAM_VIDEO_LIMIT_BYTES) {
      await status.stop('Video too large to send.');
      await bot.sendMessage(chatId, 'Video too large to send.');
      safeDelete(downloadedPath);
      return;
    }

    await bot.sendVideo(chatId, downloadedPath, {
      caption: 'Here is your downloaded video.'
    });
    await status.stop('Video sent successfully.');
    safeDelete(downloadedPath);
  } catch (error) {
    console.error('Download error:', error?.stderr || error?.message || error);
    if (status) {
      await status.stop('Failed to download or send the video.');
    }
    await bot.sendMessage(chatId, 'Failed to download or send the video.');

    if (downloadedPath) {
      safeDelete(downloadedPath);
    } else {
      cleanupByPrefix(outputPath);
    }
  }
});

console.log('Telegram bot is running...');
