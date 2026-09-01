const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const ytdlp = require('yt-dlp-exec');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 requests per windowMs
  message: { error: 'Too many requests, please try again later.' }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Temporary directory for processing
const TEMP_DIR = path.join(__dirname, 'temp');
fs.ensureDirSync(TEMP_DIR);

// Cleanup function
async function cleanupOldFiles() {
  try {
    const files = await fs.readdir(TEMP_DIR);
    const now = Date.now();
    
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stats = await fs.stat(filePath);
      const fileAge = now - stats.mtimeMs;
      
      // Delete files older than 1 hour
      if (fileAge > 3600000) {
        await fs.remove(filePath);
        console.log(`Cleaned up old file: ${file}`);
      }
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

// Run cleanup every 30 minutes
setInterval(cleanupOldFiles, 1800000);

// Facebook URL validation
function isValidFacebookUrl(url) {
  const patterns = [
    /^https?:\/\/(www\.)?facebook\.com\/.+/i,
    /^https?:\/\/(www\.)?fb\.watch\/.+/i,
    /^https?:\/\/(www\.)?facebook\.com\/watch\/.+/i,
    /^https?:\/\/(www\.)?facebook\.com\/reel\/.+/i,
    /^https?:\/\/(www\.)?facebook\.com\/share\/.+/i
  ];
  
  return patterns.some(pattern => pattern.test(url));
}

// Video info endpoint
app.get('/api/video-info', apiLimiter, async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    if (!isValidFacebookUrl(url)) {
      return res.status(400).json({ error: 'Invalid Facebook URL' });
    }
    
    // Get video info using yt-dlp
    const info = await ytdlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
      noCheckCertificate: true,
      preferFreeFormats: true,
      youtubeSkipDashManifest: true
    });
    
    // Extract relevant information
    const videoInfo = {
      title: info.title || 'Unknown Title',
      duration: info.duration || 0,
      thumbnail: info.thumbnail || '',
      uploader: info.uploader || 'Unknown',
      formats: []
    };
    
    // Get audio formats
    if (info.formats) {
      const audioFormats = info.formats.filter(f => 
        f.acodec !== 'none' && f.vcodec === 'none'
      );
      
      videoInfo.formats = audioFormats.map(f => ({
        format_id: f.format_id,
        ext: f.ext,
        quality: f.abr ? `${f.abr}kbps` : 'Unknown',
        filesize: f.filesize || 0
      }));
    }
    
    res.json(videoInfo);
  } catch (error) {
    console.error('Video info error:', error);
    res.status(500).json({ 
      error: 'Failed to get video information. Make sure the URL is valid and video is public.' 
    });
  }
});

// Convert endpoint
app.post('/api/convert', apiLimiter, async (req, res) => {
  try {
    const { url, quality = '128' } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    if (!isValidFacebookUrl(url)) {
      return res.status(400).json({ error: 'Invalid Facebook URL' });
    }
    
    // Generate unique ID for this conversion
    const conversionId = uuidv4();
    const outputPath = path.join(TEMP_DIR, `${conversionId}.mp3`);
    const videoPath = path.join(TEMP_DIR, `${conversionId}.mp4`);
    
    try {
      // Download video with best audio quality
      await ytdlp(url, {
        output: videoPath,
        format: 'bestaudio/best',
        noPlaylist: true,
        noWarnings: true,
        noCallHome: true,
        noCheckCertificate: true,
        preferFreeFormats: true
      });
      
      // Convert to MP3 using ffmpeg
      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .toFormat('mp3')
          .audioBitrate(quality)
          .audioCodec('libmp3lame')
          .on('end', resolve)
          .on('error', reject)
          .save(outputPath);
      });
      
      // Clean up video file
      await fs.remove(videoPath);
      
      // Generate download URL
      const downloadUrl = `/api/download/${conversionId}`;
      
      // Schedule cleanup after 1 hour
      setTimeout(async () => {
        try {
          await fs.remove(outputPath);
          console.log(`Cleaned up conversion: ${conversionId}`);
        } catch (error) {
          console.error(`Failed to clean up ${conversionId}:`, error);
        }
      }, 3600000);
      
      res.json({
        success: true,
        downloadUrl: downloadUrl,
        streamUrl: `/api/stream/${conversionId}`,
        fileName: `facebook-audio-${conversionId.slice(0, 8)}.mp3`
      });
      
    } catch (error) {
      console.error('Conversion error:', error);
      await fs.remove(videoPath).catch(() => {});
      await fs.remove(outputPath).catch(() => {});
      res.status(500).json({ 
        error: 'Conversion failed. Please try again with a valid video URL.' 
      });
    }
  } catch (error) {
    console.error('Convert endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Download endpoint
app.get('/api/download/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const filePath = path.join(TEMP_DIR, `${id}.mp3`);
    
    if (!await fs.pathExists(filePath)) {
      return res.status(404).json({ error: 'File not found or expired' });
    }
    
    res.download(filePath, `facebook-audio-${id.slice(0, 8)}.mp3`);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Download failed' });
  }
});

// Stream endpoint for audio player
app.get('/api/stream/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const filePath = path.join(TEMP_DIR, `${id}.mp3`);
    
    if (!await fs.pathExists(filePath)) {
      return res.status(404).json({ error: 'File not found or expired' });
    }
    
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
    uptime: process.uptime()
  });
});

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
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
  console.log(`🎵 Facebook Audio Converter running on port ${PORT}`);
  console.log(`📍 Server URL: http://localhost:${PORT}`);
  console.log('🔄 Auto cleanup enabled (1 hour intervals)');
});
