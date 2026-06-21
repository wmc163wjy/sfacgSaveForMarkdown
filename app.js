const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const axios = require('axios');
const { baseUrl, bookUid, saveMode, concurrentThreads, downloadImages } = require('./config');

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
    console.warn(`图片下载失败: ${imageUrl} - ${error.message}`);
    return false;
  }
};

// 处理章节内容中的图片
const processImagesInContent = async (content, chapterImagesDir) => {
  if (!downloadImages) {
    return content;
  }

  // 匹配 img 标签中的 src 属性
  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/g;
  let modifiedContent = content;
  let match;
  let imageCounter = 1;

  while ((match = imgRegex.exec(content)) !== null) {
    const imageUrl = match[1];
    
    // 跳过 data URI 和相对路径
    if (imageUrl.startsWith('data:') || !imageUrl.startsWith('http')) {
      continue;
    }

    const imageExtension = imageUrl.split('?')[0].split('.').pop() || 'jpg';
    const imageName = `image-${imageCounter}.${imageExtension}`;
    const imagePath = path.join(chapterImagesDir, imageName);
    const imageRelativePath = `./${path.basename(chapterImagesDir)}/${imageName}`;

    // 下载图片
    const success = await downloadImage(imageUrl, imagePath);
    
    if (success) {
      // 替换原始 URL 为本地路径
      const originalImg = match[0];
      const newImg = originalImg.replace(imageUrl, imageRelativePath);
      modifiedContent = modifiedContent.replace(originalImg, newImg);
      imageCounter++;
    }
  }

  return modifiedContent;
};

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

const getChapterDetail = async (page, url) => {
  await page.goto(url, {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  await page.waitForSelector('.article-hd .article-title, .article-content', {
    timeout: 15000
  });

  return page.evaluate(() => {
    const desc = [...document.querySelectorAll('.article-hd .article-desc .text')].map((element) => element.textContent.trim());
    
    // 获取 HTML 内容以保留图片标签
    const contentElement = document.querySelector('.article-content');
    let content = '';
    
    if (contentElement) {
      // 获取所有段落和图片
      const children = contentElement.childNodes;
      const elements = [];
      
      children.forEach((node) => {
        if (node.nodeType === 1) { // Element node
          if (node.tagName === 'P') {
            const text = node.textContent.trim();
            if (text) elements.push(text);
          } else if (node.tagName === 'IMG') {
            // 保留 img 标签的完整 HTML
            elements.push(node.outerHTML);
          }
        }
      });
      
      content = elements.join('\n\n');
    }

    return {
      title: document.querySelector('.article-hd .article-title')?.textContent?.trim() || '未知章节',
      author: desc[0] || '',
      updateTime: desc[1] || '',
      wordCount: desc[2] || '',
      content: `${content}\n\n`
    };
  });
};

const saveChapterToFile = async (chapter, detail) => {
  const bookDir = sanitizeFileName(chapter.bookTitle);
  const volumeDir = sanitizeFileName(chapter.volume);
  const chapterName = sanitizeFileName(chapter.title);
  const targetDir = path.join('.', bookDir, volumeDir);
  const chapterImagesDir = path.join(targetDir, `${chapterName}_images`);
  const targetFile = path.join(targetDir, `${chapterName}.md`);
  
  // 处理图片
  let processedContent = detail.content;
  if (downloadImages) {
    processedContent = await processImagesInContent(detail.content, chapterImagesDir);
  }
  
  const content = `# ${detail.title}\n\n${detail.author} | ${detail.updateTime} | ${detail.wordCount}\n\n${processedContent}`;

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetFile, content, 'utf8');

  return targetFile;
};

const processChaptersConcurrently = async (browser, chapters, currentSaveMode) => {
  const maxWorkers = Math.min(concurrentThreads || 3, os.cpus().length, chapters.length);
  const results = [];
  const errors = [];
  let currentIndex = 0;

  const worker = async () => {
    const page = await browser.newPage();

    try {
      while (currentIndex < chapters.length) {
        const chapterIndex = currentIndex++;
        const chapter = chapters[chapterIndex];

        try {
          const detail = await getChapterDetail(page, chapter.url);

          if (currentSaveMode === 2) {
            const filePath = await saveChapterToFile(chapter, detail);
            console.log(`Processed chapter: ${filePath}`);
          } else {
            results.push({ index: chapterIndex, chapter, detail });
            console.log(`Processed chapter: ${chapter.title}`);
          }
        } catch (error) {
          errors.push({ chapter, error: error.message });
          console.error(`Error processing chapter ${chapter.title}: ${error.message}`);
        }
      }
    } finally {
      await page.close();
    }
  };

  await Promise.all(Array.from({ length: maxWorkers }, () => worker()));

  return { results, errors };
};

const writeMergedMarkdown = async (results) => {
  const sortedResults = results.sort((a, b) => a.index - b.index);
  let outputContent = '';
  let currentBookTitle = '';
  let currentVolume = '';
  let imageCounter = 1;

  for (const result of sortedResults) {
    const { detail, chapter } = result;

    if (currentBookTitle !== chapter.bookTitle) {
      currentBookTitle = chapter.bookTitle;
      outputContent += `# ${currentBookTitle}\n\n`;
    }

    if (currentVolume !== chapter.volume) {
      currentVolume = chapter.volume;
      outputContent += `## ${currentVolume}\n\n`;
    }

    let content = detail.content;
    
    // 处理合并模式中的图片
    if (downloadImages) {
      const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/g;
      let match;
      
      while ((match = imgRegex.exec(detail.content)) !== null) {
        const imageUrl = match[1];
        
        if (imageUrl.startsWith('data:') || !imageUrl.startsWith('http')) {
          continue;
        }

        const imageExtension = imageUrl.split('?')[0].split('.').pop() || 'jpg';
        const imageName = `image-${imageCounter}.${imageExtension}`;
        const imagePath = path.join('.', 'images', imageName);

        const success = await downloadImage(imageUrl, imagePath);
        
        if (success) {
          const originalImg = match[0];
          const newImg = originalImg.replace(imageUrl, `./images/${imageName}`);
          content = content.replace(originalImg, newImg);
          imageCounter++;
        }
      }
    }

    outputContent += `### ${detail.title}\n\n${detail.author} | ${detail.updateTime} | ${detail.wordCount}\n\n${content}`;
  }

  fs.writeFileSync('output.md', outputContent, 'utf8');
  console.log('文件保存成功：output.md');
};

const getStore = async () => {
  let browser;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    const chapters = await getChapters(page, `/Novel/${bookUid}/MainIndex/`);
    await page.close();

    if (chapters.length === 0) {
      console.error('No chapters found or failed to retrieve chapters.');
      return;
    }

    const workerCount = Math.min(concurrentThreads || 3, os.cpus().length, chapters.length);
    console.log(`开始处理 ${chapters.length} 个章节，使用 ${workerCount} 个并发页面`);
    if (downloadImages) {
      console.log('图片下载：启用');
    }

    const startTime = Date.now();
    const { results, errors } = await processChaptersConcurrently(browser, chapters, saveMode);
    const endTime = Date.now();

    console.log(`处理完成，耗时: ${(endTime - startTime) / 1000}秒`);
    console.log(`成功: ${chapters.length - errors.length}, 失败: ${errors.length}`);

    if (saveMode === 1) {
      await writeMergedMarkdown(results);
    } else if (saveMode === 2) {
      console.log('所有章节保存完成，按书名/卷名分文件夹保存');
    }

    if (errors.length > 0) {
      console.log('\n处理失败的章节:');
      errors.forEach((error) => {
        console.log(`- ${error.chapter.title}: ${error.error}`);
      });
    }
  } catch (error) {
    console.error('Error in getStore:', error.message);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
};

getStore();
