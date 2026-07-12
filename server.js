const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 静态文件（前端页面）
app.use(express.static(path.join(__dirname, 'public')));

// 限流
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: '请求过于频繁，请稍后再试' }
});
app.use('/api/save', limiter);

// 数据库
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
}
const dbPath = path.join(dataDir, 'test.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS test_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            session_id TEXT,
            drink_name TEXT NOT NULL,
            E REAL,
            V REAL,
            S REAL,
            D REAL,
            e_idx INTEGER,
            v_idx INTEGER,
            s_idx INTEGER,
            d_idx INTEGER,
            device TEXT,
            screen_size TEXT,
            user_agent TEXT,
            ip_address TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS test_answers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            result_id INTEGER,
            question_index INTEGER,
            answer_value INTEGER,
            FOREIGN KEY (result_id) REFERENCES test_results(id) ON DELETE CASCADE
        )
    `);

    console.log('✅ 数据库初始化完成');
});

// 保存数据
app.post('/api/save', (req, res) => {
    const data = req.body;
    const ipAddress = req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    if (!data.drink_name || !data.answers || !Array.isArray(data.answers)) {
        return res.status(400).json({ 
            success: false, 
            error: '缺少必要字段' 
        });
    }

    db.run(`
        INSERT INTO test_results (
            timestamp, session_id, drink_name,
            E, V, S, D, e_idx, v_idx, s_idx, d_idx,
            device, screen_size, user_agent, ip_address
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        data.timestamp || new Date().toISOString(),
        data.session_id || null,
        data.drink_name,
        data.E || 0,
        data.V || 0,
        data.S || 0,
        data.D || 0,
        data.e_idx || 0,
        data.v_idx || 0,
        data.s_idx || 0,
        data.d_idx || 0,
        data.device || 'unknown',
        data.screen_size || 'unknown',
        userAgent || 'unknown',
        ipAddress || 'unknown'
    ], function(err) {
        if (err) {
            console.error('保存失败:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
        const resultId = this.lastID;

        const stmt = db.prepare(`
            INSERT INTO test_answers (result_id, question_index, answer_value) 
            VALUES (?, ?, ?)
        `);
        data.answers.forEach((val, idx) => {
            stmt.run(resultId, idx, val);
        });
        stmt.finalize();

        res.json({ success: true, message: '数据保存成功', id: resultId });
    });
});

// 管理面板
app.get('/admin', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>测试数据管理面板</title>
            <style>
                body { font-family: system-ui; max-width: 1200px; margin: 40px auto; padding: 20px; background: #f5f0eb; }
                .card { background: white; padding: 24px; border-radius: 16px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
                h1 { color: #3b2e24; }
                .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; }
                .stat-item { background: #faf8f5; padding: 16px; border-radius: 12px; text-align: center; }
                .stat-number { font-size: 28px; font-weight: bold; color: #9b7b5c; }
                .stat-label { color: #8b7a6b; font-size: 14px; }
                table { width: 100%; border-collapse: collapse; font-size: 14px; }
                th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #ede5dc; }
                th { background: #f3ede7; color: #5e4b3a; }
                .btn { background: #9b7b5c; color: white; padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; }
                .btn:hover { background: #7f6243; }
                .flex { display: flex; gap: 12px; flex-wrap: wrap; }
                input[type="password"] { padding: 8px 12px; border: 1px solid #ddd; border-radius: 6px; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>📊 测试数据管理面板</h1>
                <div style="margin: 16px 0;">
                    <label>密码：</label>
                    <input type="password" id="password" placeholder="输入管理员密码" value="admin123">
                    <button class="btn" onclick="loadData()">加载数据</button>
                </div>
                <div id="content">
                    <p style="color: #8b7a6b;">请输入密码后点击"加载数据"</p>
                </div>
            </div>

            <script>
                async function loadData() {
                    const pwd = document.getElementById('password').value;
                    if (!pwd) { alert('请输入密码'); return; }
                    const content = document.getElementById('content');
                    content.innerHTML = '<p>加载中...</p>';
                    try {
                        const statsRes = await fetch('/api/stats?key=' + pwd);
                        const stats = await statsRes.json();
                        const resultsRes = await fetch('/api/results?key=' + pwd + '&limit=20');
                        const results = await resultsRes.json();
                        let html = '<div class="stats-grid">';
                        html += '<div class="stat-item"><div class="stat-number">' + (stats.total_tests || 0) + '</div><div class="stat-label">总测试数</div></div>';
                        html += '<div class="stat-item"><div class="stat-number">' + (stats.most_common_drink || '-') + '</div><div class="stat-label">最热门饮品</div></div>';
                        html += '<div class="stat-item"><div class="stat-number">' + (stats.avg_E ? stats.avg_E.toFixed(2) : '-') + '</div><div class="stat-label">平均 E 值</div></div>';
                        html += '<div class="stat-item"><div class="stat-number">' + (stats.avg_V ? stats.avg_V.toFixed(2) : '-') + '</div><div class="stat-label">平均 V 值</div></div>';
                        html += '<div class="stat-item"><div class="stat-number">' + (stats.avg_S ? stats.avg_S.toFixed(2) : '-') + '</div><div class="stat-label">平均 S 值</div></div>';
                        html += '<div class="stat-item"><div class="stat-number">' + (stats.avg_D ? stats.avg_D.toFixed(2) : '-') + '</div><div class="stat-label">平均 D 值</div></div>';
                        html += '</div>';
                        html += '<h3>📋 最近测试记录</h3><div style="overflow-x:auto;"><table>';
                        html += '<tr><th>ID</th><th>时间</th><th>饮品</th><th>E</th><th>V</th><th>S</th><th>D</th><th>设备</th></tr>';
                        if (results && results.length > 0) {
                            results.forEach(r => {
                                html += '<tr><td>' + r.id + '</td><td>' + new Date(r.timestamp).toLocaleString() + '</td><td>' + r.drink_name + '</td><td>' + (r.E ? r.E.toFixed(2) : '-') + '</td><td>' + (r.V ? r.V.toFixed(2) : '-') + '</td><td>' + (r.S ? r.S.toFixed(2) : '-') + '</td><td>' + (r.D ? r.D.toFixed(2) : '-') + '</td><td>' + (r.device || '-') + '</td></tr>';
                            });
                        }
                        html += '</table></div>';
                        html += '<div class="flex" style="margin-top:16px;"><button class="btn" onclick="loadData()">🔄 刷新</button></div>';
                        content.innerHTML = html;
                    } catch (e) {
                        content.innerHTML = '<p style="color:red;">加载失败: ' + e.message + '</p>';
                    }
                }
                loadData();
            </script>
        </body>
        </html>
    `);
});

// 统计接口
app.get('/api/stats', (req, res) => {
    const key = req.query.key;
    if (key !== 'admin123') return res.status(403).json({ error: 'Unauthorized' });

    db.get(`
        SELECT 
            COUNT(*) as total_tests,
            AVG(E) as avg_E,
            AVG(V) as avg_V,
            AVG(S) as avg_S,
            AVG(D) as avg_D,
            (SELECT drink_name FROM test_results GROUP BY drink_name ORDER BY COUNT(*) DESC LIMIT 1) as most_common_drink
        FROM test_results
    `, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row);
    });
});

// 列表接口
app.get('/api/results', (req, res) => {
    const key = req.query.key;
    if (key !== 'admin123') return res.status(403).json({ error: 'Unauthorized' });

    const limit = parseInt(req.query.limit) || 20;
    db.all(`
        SELECT id, timestamp, drink_name, E, V, S, D, device
        FROM test_results ORDER BY id DESC LIMIT ?
    `, [limit], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.listen(PORT, () => {
    console.log('🚀 服务器已启动: http://localhost:' + PORT);
    console.log('📊 管理面板: http://localhost:' + PORT + '/admin');
    console.log('🔑 默认密码: admin123');
});
