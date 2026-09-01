const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
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
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests, please try again later.' }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Temporary directory
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
      
      if (fileAge > 3600000) {
        await fs.remove(filePath);
        console.log(`Cleaned up old file: ${file}`);
      }
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

setInterval(cleanupOldFiles, 1800000);

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ 
    status: 'ok',
    message: 'Server is running correctly',
    timestamp: new Date().toISOString()
  });
});

// Convert endpoint - Simple version for testing
app.post('/api/convert', apiLimiter, async (req, res) => {
  try {
    const { url, quality = '128' } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    const conversionId = uuidv4();
    const outputPath = path.join(TEMP_DIR, `${conversionId}.mp3`);
    
    // For now, return a test response
    // Facebook video download require special handling
    res.json({
      success: true,
      message: 'Conversion started',
      conversionId: conversionId,
      note: 'Facebook video download requires additional setup'
    });
    
  } catch (error) {
    console.error('Convert endpoint error:', error);
    res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage()
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
  console.log(`🎵 Facebook Audio Converter running on port ${PORT}`);
  console.log(`📍 Server URL: http://localhost:${PORT}`);
  console.log('✅ Server started successfully');
});
