const express = require('express');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bodyParser = require('body-parser');
const { exec } = require('child_process'); // 在文件顶部引入
const ffmpeg = require('fluent-ffmpeg');

const app = express();
const port = 3000;

// 1. 设置扫描路径 (E:\整理)
const VIDEO_DIR = 'F:'; 

// 2. 初始化数据库：这里改到了 E 盘的视频目录下
// 这样数据库更新时，位于 C 盘或 D 盘的前端项目文件夹不会有任何变化，Live Server 就不会刷新页面
const dbPath = path.join(VIDEO_DIR, 'video_metadata.db');
const db = new Database(dbPath);
// 【配置项】请修改为你的 N_m3u8DL-RE 所在的文件夹路径
const DOWNLOAD_TOOL_PATH = 'F:'; 
const INPUT_TXT_PATH = path.join(DOWNLOAD_TOOL_PATH, 'input.txt');
const BAT_FILE_NAME = 'N_m3u8DL-RE_Batch.bat';

// 创建标记表
// 初始化所有表格
db.exec(`
    CREATE TABLE IF NOT EXISTS video_covers (
        video_path TEXT PRIMARY KEY,
        thumbnail TEXT
    )
`);
db.exec(`
    CREATE TABLE IF NOT EXISTS video_info (
        video_path TEXT PRIMARY KEY,
        width INTEGER,
        height INTEGER,
        duration REAL
    )
`);
db.exec(`
    -- 1. 视频标记表
    CREATE TABLE IF NOT EXISTS video_markers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_path TEXT, 
        time REAL, 
        end_time REAL, 
        thumbnail TEXT,
        race TEXT, 
        actor TEXT, 
        pose TEXT, 
        description TEXT
    );

    -- 2. 人种配置表
    CREATE TABLE IF NOT EXISTS config_races (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        name TEXT UNIQUE
    );
   
    -- 3. 演员配置表 (核心修改点)
     CREATE TABLE IF NOT EXISTS config_actors (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        name TEXT, 
        race_name TEXT,
        UNIQUE(name, race_name) 
    );
  
    -- 4. 姿势配置表
    CREATE TABLE IF NOT EXISTS config_poses (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        name TEXT, 
        actor_name TEXT,
        UNIQUE(name, actor_name)
    );
`);
// 智能修复：确保旧表也有 end_time 列
const tableInfo = db.prepare("PRAGMA table_info(video_markers)").all();
if (!tableInfo.map(c => c.name).includes('end_time')) {
    db.exec(`ALTER TABLE video_markers ADD COLUMN end_time REAL`);
}

app.use(bodyParser.json({ limit: '10mb' })); 
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
     res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000; // 7天的毫秒数

app.use('/content', (req, res, next) => {
    // 1. 获取请求的相对路径并拼装成物理路径
    const relativePath = decodeURIComponent(req.path);
    const fullPath = path.join(VIDEO_DIR, relativePath);

    // 2. 排除预览片段 (segment_ 开头的文件不锁，或者你也可以一起锁)
    if (path.basename(fullPath).startsWith('segment_')) {
        return next(); 
    }

    // 3. 检查文件是否存在
    if (fs.existsSync(fullPath)) {
        const stats = fs.statSync(fullPath);
        const now = Date.now();
        const birthTime = stats.birthtimeMs; // 文件创建时间
        const age = now - birthTime;

        // 4. 如果不满7天，拦截请求
        if (age < SEVEN_DAYS_MS) {
            const remaining = SEVEN_DAYS_MS - age;
            const days = Math.floor(remaining / (24 * 3600000));
            const hours = Math.floor((remaining % (24 * 3600000)) / 3600000);
            
            console.log(`[系统锁死] 拦截非法访问: ${path.basename(fullPath)} (还差 ${days}天${hours}小时)`);
            
            // 返回 403 状态码
            return res.status(403).send(`
                <div style="background:#000;color:red;padding:20px;font-family:sans-serif;text-align:center;">
                    <h2>🚫 系统锁死中</h2>
                    <p>自律模式已开启：该资源加入库不足 7 天，目前处于冷却期。</p>
                    <p>解锁倒计时：<b>${days} 天 ${hours} 小时</b></p>
                </div>
            `);
        }
    }
    next();
}, express.static(VIDEO_DIR));

// 扫描视频列表
function scanVideos(dirPath, fileList = []) {
    if (!fs.existsSync(dirPath)) return fileList;
    const files = fs.readdirSync(dirPath);
    
    files.forEach(file => {
        const fullPath = path.join(dirPath, file);
        try {
            const stats = fs.statSync(fullPath);
            if (stats.isDirectory()) {
                scanVideos(fullPath, fileList);
            } else {
                const ext = path.extname(fullPath).toLowerCase();
                
                // --- 【核心修改：排除预览片段文件】 ---
                // 如果文件名以 'segment_' 开头，说明是本系统生成的预览视频，不当做“主视频”显示
                if (file.startsWith('segment_')) {
                    return; 
                }

                if (ext === '.mp4' || ext === '.m3u8' || ext === '.avi') {
                    let displayName = file;
                    if (ext === '.m3u8') {
                        displayName = path.basename(path.dirname(fullPath));
                    }

                    fileList.push({
                        name: displayName,
                        path: fullPath,
                        relativeUrl: path.relative(VIDEO_DIR, fullPath).replace(/\\/g, '/'),
                        type: ext.replace('.', ''),
                        dateAdded: stats.birthtime.toISOString().split('T')[0],
                        timestamp: stats.birthtimeMs
                    });
                }
            }
        } catch (e) {}
    });
    return fileList;
}
// 1. 初始化表结构 (增加 is_favorite 字段)
// 如果已经存在会报错，可以根据之前的方法做 try-catch 处理
// 2. 接口：切换喜欢状态
app.put('/api/markers/:id/favorite', (req, res) => {
    const { id } = req.params;
    const { is_favorite } = req.body;
     console.log("收到请求，ID:", req.params.id, "数据:", req.body); // 加这一行
    try {
        db.prepare("UPDATE video_markers SET is_favorite = ? WHERE id = ?").run(is_favorite, id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});
// 辅助函数：将视频片段转为 Base64 格式的 GIF
function generateGifBase64(inputPath, startTime, duration) {
    return new Promise((resolve, reject) => {
        // 使用 path.join 确保路径在 Windows 下不出错
        const tempFileName = path.join(__dirname, `temp_${Date.now()}.gif`);
        const maxGifDuration = 5; 
        const actualDuration = Math.min(duration, maxGifDuration);

        ffmpeg(inputPath)
            // 1. 【性能关键】在输入文件之前设置跳台，这样处理 1 小时的视频也只需 0.1 秒定位
            .inputOptions([
                '-hwaccel cuda',             // 使用 5060 硬件解码
                '-ss', startTime.toString()  // 快速定位
            ])
            .setDuration(actualDuration)
            
            // 2. 【滤镜链】
            // 移除了 hwaccel_output_format cuda，让帧自动回到内存
            // 使用 split/palettegen 算法保证 GIF 即使只有 256 色也像高清视频一样
            .videoFilters([
                'fps=10',                       // 降低帧率减小体积
                'scale=320:-1:flags=lanczos',   // 高质量缩放
                'split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse' // 生成动态调色盘，解决噪点问题
            ])
            
            // 3. 输出设置
            .outputOptions([
                '-loop 0',           // 循环播放
                '-final_delay 10'    // 最后一帧延迟
            ])
            .on('start', (commandLine) => {
                console.log('执行命令: ' + commandLine);
            })
            .on('error', (err) => {
                console.error('FFmpeg 报错:', err.message);
                reject(err);
            })
            .on('end', () => {
                try {
                    const gifBuffer = fs.readFileSync(tempFileName);
                    const base64Data = `data:image/gif;base64,${gifBuffer.toString('base64')}`;
                    // 确保读取完后再删除
                    if (fs.existsSync(tempFileName)) fs.unlinkSync(tempFileName);
                    resolve(base64Data);
                } catch (readErr) {
                    reject(readErr);
                }
            })
            .save(tempFileName);
    });
}
db.exec(`
    CREATE TABLE IF NOT EXISTS wanted_list (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_name TEXT,
        race_name TEXT,
        url TEXT,
        note TEXT,
        image TEXT, -- 新增字段
        status INTEGER DEFAULT 0,
        date_added DATE DEFAULT (datetime('now','localtime'))
    )
`);
// 智能修复：如果表已存在但没这一列，自动加上
try {
    db.exec("ALTER TABLE wanted_list ADD COLUMN image TEXT");
} catch(e) {}

/**
 * 接口：使用本地系统默认播放器打开视频
 */
app.post('/api/open-local', (req, res) => {
    const { path: videoPath } = req.body;

    if (!videoPath || !fs.existsSync(videoPath)) {
        return res.status(400).json({ success: false, message: "文件路径无效或不存在" });
    }

    // Windows 命令：start "" "文件路径"
    // 这会自动调用系统关联的默认程序（如 PotPlayer, VLC, 电影与电视等）
    exec(`start "" "${videoPath}"`, (error) => {
        if (error) {
            console.error("打开本地播放器失败:", error);
            return res.status(500).json({ success: false, message: error.message });
        }
        res.json({ success: true });
    });
});
/**
 * 接口：一键转码 AVI 为 MP4 (使用 5060 显卡加速)
 */
app.post('/api/convert-to-mp4', (req, res) => {
    const { path: inputPath } = req.body;
    const outputPath = inputPath.replace(/\.avi$/i, '.mp4');

    if (!inputPath || !fs.existsSync(inputPath)) {
        return res.status(400).json({ success: false, message: "文件不存在" });
    }

    console.log(`开始转码: ${inputPath}`);

    ffmpeg(inputPath)
        // 核心：使用 NVIDIA 硬件加速编码器
        .videoCodec('h264_nvenc') 
        // 自动设置音频（通常设为 aac 兼容性最好）
        .audioCodec('aac')
        // 这里的配置能充分发挥 5060 性能，设置高质量预设
        .outputOptions([
            '-preset p4',   // NVIDIA 预设 p1-p7，p4 是平衡，p7 是最高质量
            '-tune hq',     // 高质量调优
            '-b:v 5M'       // 设置码率为 5Mbps，保证清晰度
        ])
        .on('start', (commandLine) => {
            console.log('Spawned FFmpeg with command: ' + commandLine);
        })
        .on('progress', (progress) => {
            // 这里可以把进度通过 WebSocket 传给前端，或者简单打印
            console.log(`转码进度: ${progress.percent ? progress.percent.toFixed(2) : 0}%`);
        })
        .on('error', (err) => {
            console.error('转码失败:', err.message);
        })
        .on('end', () => {
            console.log('转码完成!');
            // 可选：转码完成后删除原 AVI 文件
            // fs.unlinkSync(inputPath); 
        })
        .save(outputPath);

    // 立即告诉前端任务已启动
    res.json({ success: true, message: "转码任务已在后台启动，完成后请刷新列表。" });
});
/**
 * 接口：更新指定 ID 的标记内容 (用于片段合并或精修)
 * 路径：PUT /api/markers/:id
 */
app.put('/api/markers/:id', (req, res) => {
    const { id } = req.params;
    const { time, end_time, description, race, actor, pose } = req.body;

    try {
        // 1. 先检查该记录是否存在
        const existing = db.prepare("SELECT id FROM video_markers WHERE id = ?").get(id);
        if (!existing) {
            return res.status(404).json({ success: false, message: "未找到该标记记录" });
        }

        // 2. 执行更新逻辑
        // 我们使用了动态处理，如果前端没传 race/actor 等字段，则保留原样
        const stmt = db.prepare(`
            UPDATE video_markers 
            SET time = ?, 
                end_time = ?, 
                description = COALESCE(?, description),
                race = COALESCE(?, race),
                actor = COALESCE(?, actor),
                pose = COALESCE(?, pose)
            WHERE id = ?
        `);

        const result = stmt.run(
            time, 
            end_time, 
            description || null, 
            race || null, 
            actor || null, 
            pose || null, 
            id
        );

        if (result.changes > 0) {
            console.log(`[数据库] 成功合并/更新片段 ID: ${id}`);
            res.json({ success: true });
        } else {
            res.json({ success: false, message: "数据未发生变化" });
        }

    } catch (e) {
        console.error("更新失败:", e);
        res.status(500).json({ success: false, message: e.message });
    }
});


// 定义一个简单的任务队列
let conversionQueue = [];
let isConverting = false;

/**
 * 核心转码函数
 */
async function processQueue() {
    if (isConverting || conversionQueue.length === 0) return;
    
    isConverting = true;
    const task = conversionQueue.shift();
    const outputPath = task.path.replace(/\.avi$/i, '.mp4');

    console.log(`[队列] 开始转码: ${task.name}`);

    ffmpeg(task.path)
        .videoCodec('h264_nvenc') // 5060 硬件加速
        .audioCodec('aac')
        .outputOptions(['-preset p4', '-tune hq'])
        .on('progress', (progress) => {
            // 可以通过 console 观察进度，如果想更高级可以接 WebSocket
            process.stdout.write(`\r进度: ${task.name} -> ${progress.percent ? progress.percent.toFixed(2) : 0}%`);
        })
        .on('error', (err) => {
            console.error(`\n[失败] ${task.name}:`, err.message);
            isConverting = false;
            processQueue(); // 继续下一个
        })
        .on('end', () => {
            console.log(`\n[完成] ${task.name}`);
            isConverting = false;
            processQueue(); // 继续下一个
        })
        .save(outputPath);
}

/**
 * 接口：提交批量转码任务
 */
app.post('/api/batch-convert', (req, res) => {
    const { video_paths } = req.body;
    
    const newTasks = video_paths.filter(p => p.toLowerCase().endsWith('.avi'));
    
    newTasks.forEach(p => {
        // 防止重复添加
        if (!conversionQueue.find(t => t.path === p)) {
            conversionQueue.push({ path: p, name: path.basename(p) });
        }
    });

    res.json({ 
        success: true, 
        message: `已添加 ${newTasks.length} 个任务到 5060 转码队列。`,
        queueLength: conversionQueue.length 
    });

    processQueue(); // 尝试启动队列
});

// --- 接口：获取清单 ---
app.get('/api/wanted', (req, res) => {
    const list = db.prepare("SELECT * FROM wanted_list ORDER BY date_added DESC").all();
    res.json({ success: true, data: list });
});
// --- 接口：仅更新指定记录的图片 ---
app.put('/api/wanted/:id/image', (req, res) => {
    const { image } = req.body;
    const { id } = req.params;
    try {
        db.prepare("UPDATE wanted_list SET image = ? WHERE id = ?").run(image, id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- 接口：添加记录 ---
// 2. 修改添加接口，接收 image 数据
app.post('/api/wanted', (req, res) => {
    const { actor_name, race_name, url, note, image } = req.body;
    db.prepare("INSERT INTO wanted_list (actor_name, race_name, url, note, image) VALUES (?, ?, ?, ?, ?)")
      .run(actor_name, race_name, url, note, image);
    res.json({ success: true });
});

// --- 接口：更新状态 (标记为已下载/已入库) ---
app.put('/api/wanted/:id', (req, res) => {
    db.prepare("UPDATE wanted_list SET status = 1 WHERE id = ?").run(req.params.id);
    res.json({ success: true });
});

// --- 接口：物理删除 ---
app.delete('/api/wanted/:id', (req, res) => {
    db.prepare("DELETE FROM wanted_list WHERE id = ?").run(req.params.id);
    res.json({ success: true });
});
// 接口：获取所有封面（用于侧边栏渲染）
app.get('/api/covers', (req, res) => {
    const covers = db.prepare("SELECT * FROM video_covers").all();
    res.json({ success: true, data: covers });
});
app.post('/api/save-video-info', (req, res) => {
    const { video_path, width, height, duration } = req.body;
    try {
        const upsert = db.prepare(`
            INSERT INTO video_info (video_path, width, height, duration) VALUES (?, ?, ?, ?)
            ON CONFLICT(video_path) DO UPDATE SET 
            width = EXCLUDED.width, height = EXCLUDED.height, duration = EXCLUDED.duration
        `);
        upsert.run(video_path, width, height, duration);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});
// 1. 初始化表结构 (db.exec 部分)
db.exec(`
    CREATE TABLE IF NOT EXISTS download_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        url TEXT UNIQUE,   -- 核心：网址必须唯一，防止重复添加链接
        cover TEXT,
        status INTEGER DEFAULT 0,
        add_date DATE DEFAULT (datetime('now','localtime'))
    )
`);

// --- 接口：获取所有下载任务 ---
app.get('/api/download/tasks', (req, res) => {
    const list = db.prepare("SELECT * FROM download_tasks ORDER BY add_date DESC").all();
    res.json({ success: true, data: list });
});

// --- 接口：添加下载任务 ---
app.post('/api/download/tasks', (req, res) => {
    const { name, url, cover } = req.body;

    try {
        // --- 策略 A：检查【下载清单】中是否已存在该链接 ---
        const existingTask = db.prepare("SELECT id, status FROM download_tasks WHERE url = ?").get(url);
        if (existingTask) {
            const statusMsg = existingTask.status === 2 ? "该视频已在下载清单中标记为‘已完成’" : "该视频已在下载任务中（等待中或下载中）";
            return res.json({ success: false, message: `链接重复：${statusMsg}` });
        }

        // --- 策略 B：检查【视频库】中是否已经有了同名视频 ---
        // 这里的 video_markers 是你之前的主视频数据库
        const existingVideo = db.prepare("SELECT id FROM video_markers WHERE video_path LIKE ? LIMIT 1")
                                .get(`%${name}%`);
        if (existingVideo) {
            return res.json({ success: false, message: "库内查重：视频库中似乎已经存在同名视频，请核实后再添加" });
        }

        // --- 策略 C：检查硬盘中是否已经有同名文件夹/文件 ---
        const checkDiskPath = path.join(VIDEO_DIR, name);
        const checkDiskPathMp4 = path.join(VIDEO_DIR, name + ".mp4");
        if (fs.existsSync(checkDiskPath) || fs.existsSync(checkDiskPathMp4)) {
            return res.json({ success: false, message: "磁盘查重：E盘整理目录中已存在同名文件或文件夹" });
        }

        // 校验通过，执行插入
        db.prepare("INSERT INTO download_tasks (name, url, cover) VALUES (?, ?, ?)")
          .run(name, url, cover);
          
        res.json({ success: true });
    } catch (e) {
        console.error("添加任务失败:", e.message);
        res.status(500).json({ success: false, message: "数据库错误或链接格式异常" });
    }
})

// --- 接口：删除任务 ---
app.delete('/api/download/tasks/:id', (req, res) => {
    db.prepare("DELETE FROM download_tasks WHERE id = ?").run(req.params.id);
    res.json({ success: true });
});

// --- 接口：【核心逻辑】生成 input.txt 并启动 .bat ---
app.post('/api/download/start-batch', (req, res) => {
    try {
        // 1. 获取任务，包含 ID
        const pendingTasks = db.prepare("SELECT id, name, url FROM download_tasks WHERE status = 0").all();
        
        if (pendingTasks.length === 0) return res.json({ success: false, message: "没有等待下载的任务" });

        // 2. 【关键修改】写入格式变为：ID$名字$网址
        const content = pendingTasks.map(t => `${t.id}$${t.name.trim()}$${t.url.trim()}`).join('\n');
        fs.writeFileSync(INPUT_TXT_PATH, content, 'utf-8');

        // 3. 修改状态为“下载中”
        db.prepare("UPDATE download_tasks SET status = 1 WHERE status = 0").run();

        // 4. 启动 .bat
        exec(`start cmd /k "cd /d ${DOWNLOAD_TOOL_PATH} && ${BAT_FILE_NAME}"`);

        res.json({ success: true, message: `已提取 ${pendingTasks.length} 条记录` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- 接口：手动标记已完成 ---
app.put('/api/download/tasks/:id/complete', (req, res) => {
    db.prepare("UPDATE download_tasks SET status = 2 WHERE id = ?").run(req.params.id);
    res.json({ success: true });
});
const puppeteer = require('puppeteer');

/**
 * 接口：通过网址自动抓取视频信息
 */
/**
 * 接口：针对特定站点精准抓取（1080p 优先）
 */
app.post('/api/scrape', async (req, res) => {
    const { targetUrl } = req.body;
    if (!targetUrl) return res.json({ success: false, message: "请输入网址" });

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // 使用 Set 存储拦截到的所有 m3u8 地址，去重
        const m3u8Set = new Set();

        page.on('request', request => {
            const url = request.url();
            if (url.includes('.m3u8')) {
                m3u8Set.add(url);
            }
        });

        // 1. 访问页面
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // 2. 模拟真实等待：多等一会儿（5秒），给播放器足够时间加载不同分辨率的清单
        await new Promise(r => setTimeout(r, 5000));

        // 3. 抓取数据
        const pageData = await page.evaluate(() => {
            // 抓取标题
            const titleEl = document.querySelector('h1');
            
            // 抓取封面 - 尝试多种定位方式
            // A. 你提供的特定长选择器
            const posterEl = document.querySelector('div.plyr__poster');
            // B. 找 video 标签的 poster 属性
            const videoEl = document.querySelector('video');
            
            let coverUrl = '';
            if (posterEl) {
                const bgImg = window.getComputedStyle(posterEl).backgroundImage;
                if (bgImg && bgImg !== 'none') {
                    coverUrl = bgImg.replace(/url\(['"]?(.*?)['"]?\)/i, '$1');
                }
            }
            
            if (!coverUrl && videoEl) {
                coverUrl = videoEl.getAttribute('poster');
            }

            return {
                title: titleEl ? titleEl.innerText.trim() : document.title,
                cover: coverUrl
            };
        });

        await browser.close();

        // 4. 【核心逻辑】处理分辨率优先级
        let m3u8List = Array.from(m3u8Set);
        
        // 如果抓到了任何分辨率，尝试根据规律预测更高清晰度
        // 比如抓到了 .../480p/video.m3u8，我们生成对应的 1080p 和 720p 放入待选列表
        const expandedList = [];
        m3u8List.forEach(url => {
            expandedList.push(url);
            if (url.includes('/480p/')) {
                expandedList.push(url.replace('/480p/', '/1080p/'));
                expandedList.push(url.replace('/480p/', '/720p/'));
            }
            if (url.includes('/720p/')) {
                expandedList.push(url.replace('/720p/', '/1080p/'));
            }
        });

        // 按优先级筛选：1080p > 720p > 480p > 其他
        const finalM3u8 = expandedList.find(u => u.includes('1080p')) || 
                          expandedList.find(u => u.includes('720p')) || 
                          expandedList.find(u => u.includes('480p')) || 
                          expandedList[0];

        console.log(`[爬虫成功] 标题: ${pageData.title}`);
        console.log(`[爬虫成功] 最终选择地址: ${finalM3u8}`);

        res.json({
            success: true,
            data: {
                name: pageData.title,
                url: finalM3u8,
                cover: pageData.cover
            }
        });

    } catch (e) {
        if (browser) await browser.close();
        console.error("抓取失败:", e);
        res.status(500).json({ success: false, message: e.message });
    }
});
// --- 接口：供下载脚本调用的完成信号 ---
// 路径：GET /api/download/callback?name=视频名称
app.get('/api/download/callback', (req, res) => {
    const { id } = req.query; // 接收 ID
    
    console.log(`\n[回调调试] 收到完成信号，ID: ${id}`);

    if (!id) return res.status(400).send("Missing ID");

    try {
        // 使用 ID 进行精准更新
        const stmt = db.prepare("UPDATE download_tasks SET status = 2 WHERE id = ?");
        const result = stmt.run(id);

        if (result.changes > 0) {
            console.log(`[回调成功] 任务 ID ${id} 状态已更新为：已完成`);
            res.send("OK");
        } else {
            console.warn(`[回调警告] 数据库中没找到 ID 为 ${id} 的任务`);
            res.send("Not Found");
        }
    } catch (e) {
        console.error("[回调错误]", e.message);
        res.status(500).send(e.message);
    }
});
// --- 在静态资源映射处修改 ---

// --- 接口：一键重置所有“下载中”的任务为“等待中” ---
app.post('/api/download/tasks/reset-all', (req, res) => {
    try {
        const result = db.prepare("UPDATE download_tasks SET status = 0 WHERE status = 1").run();
        res.json({ success: true, message: `已重置 ${result.changes} 个任务` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- 接口：将单个任务重置为“等待中” ---
app.put('/api/download/tasks/:id/reset', (req, res) => {
    try {
        db.prepare("UPDATE download_tasks SET status = 0 WHERE id = ?").run(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});
// 接口：获取特定演员、特定姿势的参考缩略图
app.get('/api/pose-preview', (req, res) => {
    const { actor, pose } = req.query;
    if (!actor || !pose) return res.json({ success: false, data: [] });

    try {
        // 查询该演员在该姿势下的前 10 张缩略图
        const thumbnails = db.prepare(`
            SELECT thumbnail FROM video_markers 
            WHERE actor = ? AND pose = ? AND thumbnail != ''
            LIMIT 10
        `).all(actor, pose);

        res.json({ success: true, data: thumbnails });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 接口：保存/更新封面
app.post('/api/save-cover', (req, res) => {
    const { video_path, thumbnail } = req.body;
    try {
        const upsert = db.prepare(`
            INSERT INTO video_covers (video_path, thumbnail) VALUES (?, ?)
            ON CONFLICT(video_path) DO UPDATE SET thumbnail = EXCLUDED.thumbnail
        `);
        upsert.run(video_path, thumbnail);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 获取系统中所有的标记（用于按姿势全局分类）
// 获取系统中所有的标记（用于按姿势全局分类）
app.get('/api/all-markers', (req, res) => {
    try {
        // --- 核心增强：关联查询，并优化排序逻辑 ---
        // 排序规则：首先按 is_favorite 倒序（喜欢的在最前），然后按 ID 倒序（最新的在最前）
        const markers = db.prepare(`
            SELECT 
                m.*, 
                i.width, 
                i.height, 
                i.duration as total_duration
            FROM video_markers m
            LEFT JOIN video_info i ON m.video_path = i.video_path
            ORDER BY m.is_favorite DESC, m.id DESC
        `).all();
        
        const data = markers.map(m => {
            // 确保路径兼容性
            const rel = path.relative(VIDEO_DIR, m.video_path).replace(/\\/g, '/');
            const ext = path.extname(m.video_path).replace('.', '');
            
            return { 
                ...m, 
                relativeUrl: rel, 
                type: ext,
                // 确保 is_favorite 始终有值 (0 或 1)
                is_favorite: m.is_favorite || 0,
                // 封装媒体对象供前端统一标签逻辑
                media: m.height ? { width: m.width, height: m.height, duration: m.total_duration } : null
            };
        });
        
        res.json({ success: true, data });
    } catch (e) {
        console.error("获取全量标记失败:", e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});
// 批量更新视频的人种和演员
app.post('/api/batch-update', (req, res) => {
    const { video_paths, race, actor } = req.body;
    
    if (!video_paths || video_paths.length === 0) {
        return res.json({ success: false, message: "未选择视频" });
    }

    try {
        // 使用事务处理，保证速度和一致性
        const insertOrUpdate = db.transaction((paths) => {
            for (const v_path of paths) {
                // 1. 检查该视频是否已有标记
                const existing = db.prepare("SELECT id FROM video_markers WHERE video_path = ? LIMIT 1").get(v_path);
                
                if (existing) {
                    // 2. 如果已有标记，更新该视频名下的所有记录（人种和演员）
                    db.prepare("UPDATE video_markers SET race = ?, actor = ? WHERE video_path = ?")
                      .run(race, actor, v_path);
                } else {
                    // 3. 【关键修复】如果视频是全新的（未标记），创建一个 0:00 的占位标记
                    // 这样数据库里就有了这个视频的“归属信息”，筛选页和批量页就能看到它了
                    db.prepare(`
                        INSERT INTO video_markers (
                            video_path, time, end_time, race, actor, pose, description, thumbnail
                        ) VALUES (?, 0, 0, ?, ?, '未设定', '批量快速标记', '')
                    `).run(v_path, race, actor);
                }
            }
        });

        insertOrUpdate(video_paths);
        res.json({ success: true, message: `成功更新 ${video_paths.length} 个视频` });
    } catch (e) {
        console.error("批量更新出错:", e);
        res.status(500).json({ success: false, message: e.message });
    }
});
// --- 配置管理接口 ---

// 获取所有配置数据
app.get('/api/config', (req, res) => {
    const races = db.prepare("SELECT * FROM config_races").all();
    const actors = db.prepare("SELECT * FROM config_actors").all();
    const poses = db.prepare("SELECT * FROM config_poses").all();
    res.json({ success: true, races, actors, poses });
});

// 添加配置 (category: races, actors, poses)
app.post('/api/config/:category', (req, res) => {
    const { category } = req.params;
    const { name, race_name, actor_name } = req.body; // 接收参数
    try {
        if (category === 'races') {
            db.prepare("INSERT INTO config_races (name) VALUES (?)").run(name);
        } else if (category === 'actors') {
            db.prepare("INSERT INTO config_actors (name, race_name) VALUES (?, ?)").run(name, race_name);
        } else if (category === 'poses') {
            // 保存姿势时记录所属演员
            db.prepare("INSERT INTO config_poses (name, actor_name) VALUES (?, ?)").run(name, actor_name);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, message: "已存在或输入无效" });
    }
});

// 删除配置
app.delete('/api/config/:category/:id', (req, res) => {
    const { category, id } = req.params;
    const table = `config_${category}`;
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    res.json({ success: true });
});
// 接口
app.get('/api/videos', (req, res) => {
    const files = scanVideos(VIDEO_DIR);
    
    // 1. 获取视频媒体信息 (分辨率/时长)
    const cachedInfo = db.prepare("SELECT * FROM video_info").all();
    const infoMap = {};
    cachedInfo.forEach(i => infoMap[i.video_path] = i);

    // 2. 【新增】从标记表获取每个视频的“归属信息” (人种/演员)
    // 我们取每个视频路径下 ID 最小或最大的那条记录作为“主属性”
    const markerMeta = db.prepare(`
        SELECT video_path, race, actor 
        FROM video_markers 
        GROUP BY video_path
    `).all();
    const metaMap = {};
    markerMeta.forEach(m => metaMap[m.video_path] = m);

    // 3. 合并所有数据
    const data = files.map(f => {
        const pathKey = f.path; // 注意：确保存储路径和扫描路径格式一致
        return {
            ...f,
            media: infoMap[pathKey] || null,
            // 将人种和演员直接注入视频对象
            race: metaMap[pathKey] ? metaMap[pathKey].race : '',
            actor: metaMap[pathKey] ? metaMap[pathKey].actor : ''
        };
    });

    res.json({ success: true, data });
});
// 新增：物理删除视频及其关联数据
app.delete('/api/videos', (req, res) => {
    const { path: videoPath } = req.body;

    if (!videoPath) return res.status(400).json({ success: false, message: "缺少路径" });

    try {
        // 1. 从所有数据库表中删除关联记录
        db.prepare("DELETE FROM video_markers WHERE video_path = ?").run(videoPath);
        db.prepare("DELETE FROM video_covers WHERE video_path = ?").run(videoPath);
        db.prepare("DELETE FROM video_info WHERE video_path = ?").run(videoPath);

        // 2. 删除物理文件
        if (fs.existsSync(videoPath)) {
            const stats = fs.statSync(videoPath);
            if (stats.isDirectory()) {
                // 如果是文件夹（某些 m3u8 情况），递归删除
                fs.rmSync(videoPath, { recursive: true, force: true });
            } else {
                // 如果是普通文件 (.mp4)
                fs.unlinkSync(videoPath);
            }
            console.log(`文件已从硬盘删除: ${videoPath}`);
        }

        res.json({ success: true, message: "视频及数据已彻底删除" });
    } catch (e) {
        console.error("删除失败:", e);
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/markers', (req, res) => {
    const videoPath = req.query.path;
    const markers = db.prepare('SELECT * FROM video_markers WHERE video_path = ? ORDER BY time ASC').all(videoPath);
    res.json({ success: true, data: markers });
});
/**
 * 接口：新增标记（带查重逻辑）
 */
// 1. 静态资源映射：让浏览器能访问生成的预览视频
// 假设你的 index.html 在 client 文件夹，后端在 server 文件夹
app.post('/api/markers', async (req, res) => {
    const { video_path, time, end_time, race, actor, pose, description } = req.body;

    try {
        const absoluteVideoPath = path.resolve(video_path);
        const absoluteVideoDir = path.dirname(absoluteVideoPath);
        const previewFileName = `segment_${Date.now()}.mp4`;
        const previewDiskPath = path.join(absoluteVideoDir, previewFileName);

        // 计算截取时长
        const duration = end_time - time;
        if (duration <= 0) throw new Error("时长必须大于 0");

        const runFfmpeg = () => {
            return new Promise((resolve, reject) => {
                ffmpeg(absoluteVideoPath)
                    // --- 【极速模式关键 1：在输入之前定位】 ---
                    .inputOptions([
                        '-ss', time.toString() 
                    ])
                    .outputOptions([
                        `-t ${duration}`,        // 截取时长
                        '-c copy',               // 【极速模式关键 2：音视频流直接拷贝，不重编码】
                        '-map 0',                // 确保拷贝所有轨道（画面+声音）
                        '-movflags +faststart'   // 优化网页播放：元数据前置
                    ])
                    .on('end', resolve)
                    .on('error', (err) => {
                        console.error("FFmpeg 错误:", err);
                        reject(err);
                    })
                    .save(previewDiskPath);
            });
        };

        await runFfmpeg();

        // 路径转换逻辑
        let relativePath = path.relative(VIDEO_DIR, previewDiskPath).replace(/\\/g, '/').replace(/^\//, '');
        const previewUrl = `/content/${relativePath}`;

        // 写入数据库
        const stmt = db.prepare(`
            INSERT INTO video_markers (video_path, time, end_time, thumbnail, race, actor, pose, description) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(video_path, time, end_time, previewUrl, race, actor, pose, description);
        
        res.json({ success: true, previewUrl });
        
    } catch (err) {
        console.error("生成失败:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});
app.delete('/api/markers/:id', (req, res) => {
    const { id } = req.params;
    console.log(`\n[DEBUG-DELETE] >>> 收到删除请求, ID: ${id}`);

    try {
        // 1. 先验证数据是否存在
        const marker = db.prepare("SELECT * FROM video_markers WHERE id = ?").get(id);
        if (!marker) {
            console.error(`[DEBUG-DELETE] ❌ 失败: 数据库中找不到 ID 为 ${id} 的记录`);
            return res.status(404).json({ success: false, message: "标记不存在" });
        }

        console.log(`[DEBUG-DELETE] 找到记录, 关联视频: ${marker.video_path}`);

        // 2. 执行数据库删除
        const result = db.prepare("DELETE FROM video_markers WHERE id = ?").run(id);
        console.log(`[DEBUG-DELETE] 数据库操作完成, 影响行数: ${result.changes}`);

        if (result.changes === 0) {
            throw new Error("数据库删除指令执行成功但未修改任何行");
        }

        // 3. 物理文件删除调试
        if (marker.thumbnail && marker.thumbnail.includes('segment_')) {
            const relativePath = marker.thumbnail.replace('/content/', '');
            const physicalPath = path.join(VIDEO_DIR, relativePath);
            console.log(`[DEBUG-DELETE] 准备删除物理文件: ${physicalPath}`);

            if (fs.existsSync(physicalPath)) {
                fs.unlinkSync(physicalPath);
                console.log(`[DEBUG-DELETE] ✅ 物理文件已删除`);
            } else {
                console.warn(`[DEBUG-DELETE] ⚠️ 警告: 物理文件不存在，跳过文件删除`);
            }
        }

        res.json({ success: true, message: "后端删除成功" });

    } catch (e) {
        console.error("[DEBUG-DELETE] 💥 后端崩溃:", e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});
// 接口：根据 ID 获取单个标记详情
app.get('/api/marker/:id', (req, res) => {
    try {
        const marker = db.prepare("SELECT * FROM video_markers WHERE id = ?").get(req.params.id);
        if (!marker) return res.status(404).json({ success: false, message: "标记不存在" });

        // 补充播放所需的相对路径
        const rel = path.relative(VIDEO_DIR, marker.video_path).replace(/\\/g, '/');
        const ext = path.extname(marker.video_path).replace('.', '');
        
        res.json({ 
            success: true, 
            data: { ...marker, relativeUrl: rel, type: ext } 
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 接口：更新现有标记
app.put('/api/markers/:id', (req, res) => {
    const { id } = req.params;
    const { time, end_time, race, actor, pose, description } = req.body;
    try {
        db.prepare(`
            UPDATE video_markers 
            SET time = ?, end_time = ?, race = ?, actor = ?, pose = ?, description = ?
            WHERE id = ?
        `).run(time, end_time, race, actor, pose, description, id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});


app.listen(port, () => {
   


    console.log(`Server running at http://localhost:${port}`);
    console.log(`数据库已保存至: ${dbPath}`);
});