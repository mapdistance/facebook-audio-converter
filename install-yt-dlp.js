const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { execSync } = require('child_process');

async function installYtDlp() {
  console.log('📥 Installing yt-dlp...');
  
  const binDir = path.join(__dirname, 'bin');
  fs.ensureDirSync(binDir);
  
  const platform = process.platform;
  let url;
  let binaryName;
  
  if (platform === 'linux') {
    url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
    binaryName = 'yt-dlp';
  } else if (platform === 'darwin') {
    url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
    binaryName = 'yt-dlp';
  } else if (platform === 'win32') {
    url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
    binaryName = 'yt-dlp.exe';
  } else {
    console.log('⚠️ Unsupported platform:', platform);
    return;
  }
  
  const binaryPath = path.join(binDir, binaryName);
  
  try {
    // Download yt-dlp binary
    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream'
    });
    
    const writer = fs.createWriteStream(binaryPath);
    response.data.pipe(writer);
    
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    
    // Make executable
    if (platform !== 'win32') {
      fs.chmodSync(binaryPath, 0o755);
    }
    
    console.log('✅ yt-dlp installed successfully at:', binaryPath);
  } catch (error) {
    console.error('❌ Failed to download yt-dlp:', error.message);
  }
}

installYtDlp();
