const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const axios = require('axios');
const { baseUrl, bookUid, concurrentThreads } = require('./config');

const sanitizeFileName = (fileName) => {
  return fileName.replace(/[<>:"/\\|?*]/g, '_').trim();
};

const getChromeExecutablePath = () => {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate));
};

const launchBrowser = async () => {
  const executablePath = getChromeExecutablePath();
  const launchOptions = {
    headless: 'new'
  };

  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }

  return puppeteer.launch(launchOptions);
};

// 下载单个图片
const downloadImage = async (imageUrl, imagePath) => {
  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, response.data);
    return true;
  } catch (error) {
    console.warn(`❌ 图片下载失败: ${imageUrl} - ${error.message}`);
    return false;
  }
};

// 从章节 HTML 中提取所有图片 URL
const extractImagesFromChapter = async (page, chapterUrl) => {
  try {
    await page.goto(chapterUrl, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await page.waitForSelector('.article-content', {
      timeout: 15000
    });

    const images = await page.evaluate(() => {
      const imgElements = document.querySelectorAll('.article-content img');
      const urls = [];
      
      imgElements.forEach((img) => {
        const src = img.getAttribute('src');
        if (src && src.startsWith('http')) {
          urls.push(src);
        }
      });
      
      return urls;
    });

    return images;
  } catch (error) {
    console.warn(`章节加载失败: ${chapterUrl} - ${error.message}`);
    return [];
  }
};

// 获取所有章节 URL
const getChapters = async (page, bookPageUrl) => {
  const targetUrl = new URL(bookPageUrl, baseUrl).toString();

  await page.goto(targetUrl, {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  await page.waitForSelector('.story-title', {
    timeout: 15000
  });

  return page.evaluate(() => {
    const chapters = [];
    const bookTitle = document.querySelector('.story-title')?.textContent?.trim() || '未知书名';

    document.querySelectorAll('.story-catalog').forEach((volumeElement, volumeIndex) => {
      const volumeTitle = volumeElement.querySelector('.catalog-title')?.textContent?.trim() || `卷${volumeIndex + 1}`;

      volumeElement.querySelectorAll('.catalog-list .clearfix > li > a').forEach((anchor) => {
        const href = anchor.getAttribute('href');
        const chapterTitle = anchor.textContent.trim();

        if (href) {
          chapters.push({
            url: anchor.href,
            title: chapterTitle,
            volume: volumeTitle,
            bookTitle
          });
        }
      });
    });

    if (chapters.length === 0) {
      document.querySelectorAll('.clearfix > li > a').forEach((anchor) => {
        const href = anchor.getAttribute('href');
        const chapterTitle = anchor.textContent.trim();

        if (href) {
          chapters.push({
            url: anchor.href,
            title: chapterTitle,
            volume: '默认卷',
            bookTitle
          });
        }
      });
    }

    return chapters;
  });
};

// 并发下载图片
const downloadImagesFromChapters = async (browser, chapters, outputDir) => {
  const maxWorkers = Math.min(concurrentThreads || 3, os.cpus().length);
  const results = {
    total: 0,
    success: 0,
    failed: 0,
    skipped: 0
  };
  let currentIndex = 0;
  const downloadedUrls = new Set();

  const worker = async () => {
    const page = await browser.newPage();

    try {
      while (currentIndex < chapters.length) {
        const chapterIndex = currentIndex++;
        const chapter = chapters[chapterIndex];

        try {
          console.log(`[${chapterIndex + 1}/${chapters.length}] 正在处理: ${chapter.title}`);
          
          const imageUrls = await extractImagesFromChapter(page, chapter.url);
          
          if (imageUrls.length === 0) {
            console.log(`  ℹ️ 未找到图片`);
            continue;
          }

          console.log(`  找到 ${imageUrls.length} 张图片`);

          for (const imageUrl of imageUrls) {
            if (downloadedUrls.has(imageUrl)) {
              results.skipped++;
              continue;
            }

            results.total++;
            const imageExtension = imageUrl.split('?')[0].split('.').pop() || 'jpg';
            const imageName = `${sanitizeFileName(chapter.volume)}_${sanitizeFileName(chapter.title)}_${results.total}.${imageExtension}`;
            const imagePath = path.join(outputDir, imageName);

            const success = await downloadImage(imageUrl, imagePath);
            
            if (success) {
              results.success++;
              console.log(`  ✓ 已下载: ${imageName}`);
            } else {
              results.failed++;
            }

            downloadedUrls.add(imageUrl);
          }
        } catch (error) {
          console.error(`处理章节失败 ${chapter.title}: ${error.message}`);
        }
      }
    } finally {
      await page.close();
    }
  };

  console.log(`\n开始下载，使用 ${maxWorkers} 个并发线程...\n`);

  const startTime = Date.now();
  await Promise.all(Array.from({ length: maxWorkers }, () => worker()));
  const endTime = Date.now();

  return { results, duration: (endTime - startTime) / 1000 };
};

const main = async () => {
  let browser;

  try {
    const outputDir = path.join('.', `images_${sanitizeFileName(bookUid)}`);
    
    console.log('='.repeat(60));
    console.log('🖼️  SF 轻小说图片下载工具');
    console.log('='.repeat(60));
    console.log(`小说 ID: ${bookUid}`);
    console.log(`输出目录: ${outputDir}`);
    console.log(`并发线程: ${concurrentThreads || 3}`);
    console.log('='.repeat(60) + '\n');

    browser = await launchBrowser();
    const page = await browser.newPage();

    console.log('📖 正在获取章节列表...\n');
    const chapters = await getChapters(page, `/Novel/${bookUid}/MainIndex/`);
    await page.close();

    if (chapters.length === 0) {
      console.error('❌ 未找到任何章节');
      return;
    }

    console.log(`✓ 找到 ${chapters.length} 个章节\n`);

    // 创建输出目录
    fs.mkdirSync(outputDir, { recursive: true });

    // 开始下载
    const { results, duration } = await downloadImagesFromChapters(browser, chapters, outputDir);

    console.log('\n' + '='.repeat(60));
    console.log('📊 下载完成统计');
    console.log('='.repeat(60));
    console.log(`总图片数: ${results.total}`);
    console.log(`✓ 成功下载: ${results.success}`);
    console.log(`❌ 下载失败: ${results.failed}`);
    console.log(`⊘ 已跳过重复: ${results.skipped}`);
    console.log(`⏱️  总耗时: ${duration.toFixed(2)} 秒`);
    console.log(`📂 保存目录: ${path.resolve(outputDir)}`);
    console.log('='.repeat(60));

  } catch (error) {
    console.error('错误:', error.message);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
};

main();
