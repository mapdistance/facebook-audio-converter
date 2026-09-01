const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const QRCode = require('qrcode');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: 'Too many requests, please try again later.' }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Temporary directory
const TEMP_DIR = path.join(__dirname, 'temp');
fs.ensureDirSync(TEMP_DIR);

// yt-dlp binary path
const YTDLP_PATH = path.join(__dirname, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

// Cleanup function
async function cleanupOldFiles() {
  try {
    const files = await fs.readdir(TEMP_DIR);
    const now = Date.now();
    
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stats = await fs.stat(filePath);
      const fileAge = now - stats.mtimeMs;
      
      if (fileAge > 3600000) {
        await fs.remove(filePath);
        console.log(`Cleaned up: ${file}`);
      }
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

setInterval(cleanupOldFiles, 1800000);

// URL validation
function isValidUrl(url) {
  const patterns = [
    /^https?:\/\/(www\.)?facebook\.com\/.+/i,
    /^https?:\/\/(www\.)?fb\.watch\/.+/i,
    /^https?:\/\/(www\.)?youtube\.com\/watch\?v=.+/i,
    /^https?:\/\/youtu\.be\/.+/i,
    /^https?:\/\/(www\.)?instagram\.com\/.+/i,
    /^https?:\/\/(www\.)?tiktok\.com\/.+/i,
    /^https?:\/\/(www\.)?twitter\.com\/.+/i,
    /^https?:\/\/(www\.)?x\.com\/.+/i
  ];
  
  return patterns.some(pattern => pattern.test(url));
}

// Platform detection
function detectPlatform(url) {
  if (url.includes('facebook.com') || url.includes('fb.watch')) return 'facebook';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('tiktok.com')) return 'tiktok';
  if (url.includes('twitter.com') || url.includes('x.com')) return 'twitter';
  return 'unknown';
}

// Video info endpoint
app.get('/api/video-info', apiLimiter, async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    if (!isValidUrl(url)) {
      return res.status(400).json({ error: 'Invalid URL' });
    }
    
    const { stdout } = await execPromise(
      `"${YTDLP_PATH}" --dump-json --no-warnings --no-call-home "${url}"`,
      { timeout: 60000 }
    );
    
    const info = JSON.parse(stdout);
    
    res.json({
      title: info.title || 'Unknown Title',
      duration: info.duration || 0,
      thumbnail: info.thumbnail || '',
      uploader: info.uploader || info.channel || 'Unknown',
      platform: detectPlatform(url),
      formats: info.formats ? info.formats.map(f => ({
        format_id: f.format_id,
        ext: f.ext,
        quality: f.height ? `${f.height}p` : f.abr ? `${f.abr}kbps` : 'Unknown',
        filesize: f.filesize || 0
      })) : []
    });
    
  } catch (error) {
    console.error('Video info error:', error);
    res.status(500).json({ 
      error: 'Failed to get video information.' 
    });
  }
});

// Video download endpoint (MP4)
app.post('/api/download-video', apiLimiter, async (req, res) => {
  try {
    const { url, quality = 'best' } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    if (!isValidUrl(url)) {
      return res.status(400).json({ error: 'Invalid URL' });
    }
    
    const conversionId = uuidv4();
    const outputPath = path.join(TEMP_DIR, `${conversionId}.mp4`);
    
    try {
      const formatMap = {
        '144': 'best[height<=144]',
        '240': 'best[height<=240]',
        '360': 'best[height<=360]',
        '480': 'best[height<=480]',
        '720': 'best[height<=720]',
        '1080': 'best[height<=1080]',
        'best': 'best'
      };
      
      const format = formatMap[quality] || 'best';
      
      const command = `"${YTDLP_PATH}" -f "${format}" -o "${outputPath}" --no-warnings --no-call-home --no-playlist "${url}"`;
      
      await execPromise(command, { timeout: 300000, maxBuffer: 1024 * 1024 * 10 });
      
      if (!await fs.pathExists(outputPath)) {
        throw new Error('Output file not created');
      }
      
      const downloadUrl = `/api/download/${conversionId}`;
      
      setTimeout(async () => {
        await fs.remove(outputPath).catch(() => {});
      }, 3600000);
      
      res.json({
        success: true,
        downloadUrl: downloadUrl,
        fileName: `video-${conversionId.slice(0, 8)}.mp4`
      });
      
    } catch (error) {
      console.error('Video download error:', error);
      await fs.remove(outputPath).catch(() => {});
      res.status(500).json({ error: 'Download failed.' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Audio convert endpoint (Multi-format)
app.post('/api/convert-audio', apiLimiter, async (req, res) => {
  try {
    const { url, quality = '128', format = 'mp3' } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    if (!isValidUrl(url)) {
      return res.status(400).json({ error: 'Invalid URL' });
    }
    
    const conversionId = uuidv4();
    const outputPath = path.join(TEMP_DIR, `${conversionId}.${format}`);
    
    try {
      const command = `"${YTDLP_PATH}" -x --audio-format ${format} --audio-quality ${quality} -o "${outputPath}" --no-warnings --no-call-home --no-playlist "${url}"`;
      
      await execPromise(command, { timeout: 300000, maxBuffer: 1024 * 1024 * 10 });
      
      if (!await fs.pathExists(outputPath)) {
        throw new Error('Output file not created');
      }
      
      const downloadUrl = `/api/download/${conversionId}`;
      const streamUrl = `/api/stream/${conversionId}`;
      
      setTimeout(async () => {
        await fs.remove(outputPath).catch(() => {});
      }, 3600000);
      
      res.json({
        success: true,
        downloadUrl: downloadUrl,
        streamUrl: streamUrl,
        fileName: `audio-${conversionId.slice(0, 8)}.${format}`
      });
      
    } catch (error) {
      console.error('Audio conversion error:', error);
      await fs.remove(outputPath).catch(() => {});
      res.status(500).json({ error: 'Conversion failed.' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Generic convert endpoint (backward compatibility)
app.post('/api/convert', apiLimiter, async (req, res) => {
  req.body.format = 'mp3';
  return app._router.handle(req, res);
});

// Image download endpoint
app.post('/api/download-image', apiLimiter, async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    const conversionId = uuidv4();
    const outputPath = path.join(TEMP_DIR, `${conversionId}.jpg`);
    
    try {
      const command = `"${YTDLP_PATH}" --skip-download --write-thumbnail -o "${TEMP_DIR}/${conversionId}" --no-warnings "${url}"`;
      
      await execPromise(command, { timeout: 60000 });
      
      const files = await fs.readdir(TEMP_DIR);
      const thumbnailFile = files.find(f => f.startsWith(conversionId) && !f.endsWith('.mp3') && !f.endsWith('.mp4'));
      
      if (!thumbnailFile) {
        throw new Error('Thumbnail not found');
      }
      
      const thumbnailPath = path.join(TEMP_DIR, thumbnailFile);
      
      const downloadUrl = `/api/download/${conversionId}`;
      
      res.json({
        success: true,
        downloadUrl: downloadUrl,
        fileName: thumbnailFile
      });
      
    } catch (error) {
      console.error('Image download error:', error);
      res.status(500).json({ error: 'Image download failed.' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// QR Code generation endpoint
app.get('/api/generate-qr', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    const qrCode = await QRCode.toDataURL(url, {
      width: 300,
      margin: 2,
      color: {
        dark: '#1877f2',
        light: '#ffffff'
      }
    });
    
    res.json({
      success: true,
      qrCode: qrCode
    });
    
  } catch (error) {
    console.error('QR generation error:', error);
    res.status(500).json({ error: 'QR code generation failed' });
  }
});

// Download endpoint
app.get('/api/download/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const files = await fs.readdir(TEMP_DIR);
    const file = files.find(f => f.startsWith(id));
    
    if (!file) {
      return res.status(404).json({ error: 'File not found or expired' });
    }
    
    const filePath = path.join(TEMP_DIR, file);
    res.download(filePath);
    
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Download failed' });
  }
});

// Stream endpoint
app.get('/api/stream/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const files = await fs.readdir(TEMP_DIR);
    const file = files.find(f => f.startsWith(id) && (f.endsWith('.mp3') || f.endsWith('.m4a') || f.endsWith('.wav')));
    
    if (!file) {
      return res.status(404).json({ error: 'File not found or expired' });
    }
    
    const filePath = path.join(TEMP_DIR, file);
    const stat = await fs.stat(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'audio/mpeg',
      });
      
      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'audio/mpeg',
      });
      
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (error) {
    console.error('Stream error:', error);
    res.status(500).json({ error: 'Streaming failed' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    platform: process.platform,
    memory: process.memoryUsage()
  });
});

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ 
    status: 'ok',
    message: 'Server is running correctly',
    ytdlpExists: fs.pathExistsSync(YTDLP_PATH),
    tempDirExists: fs.pathExistsSync(TEMP_DIR)
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🎵 Multi-Platform Downloader running on port ${PORT}`);
  console.log(`✅ Server started successfully`);
  console.log(`📦 Features: Video Download, Audio Convert, Image Download`);
});
