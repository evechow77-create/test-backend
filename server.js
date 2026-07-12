const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== 中间件 ====================
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 静态文件（前端页面）
app.use(express.static(path.join(__dirname, 'public')));

// ==================== 限流 ====================
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: '请求过于频繁，请稍后再试' }
});
app.use('/api/save', limiter);

// ==================== PostgreSQL 数据库 ====================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// 创建表
pool.query(`
    CREATE TABLE IF NOT EXISTS test_results (
        id SERIAL PRIMARY KEY,
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`).catch(err => console.error('创建 test_results 表失败:', err));

pool.query(`
    CREATE TABLE IF NOT EXISTS test_answers (
        id SERIAL PRIMARY KEY,
        result_id INTEGER REFERENCES test_results(id) ON DELETE CASCADE,
        question_index INTEGER,
        answer_value INTEGER
    )
`).catch(err => console.error('创建 test_answers 表失败:', err));

console.log('✅ PostgreSQL 数据库连接已初始化');

// ==================== 保存数据 API ====================
app.post('/api/save', async (req, res) => {
    const data = req.body;
    const ipAddress = req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    if (!data.drink_name || !data.answers || !Array.isArray(data.answers)) {
        return res.status(400).json({
            success: false,
            error: '缺少必要字段'
        });
    }

    try {
        // 插入主表，返回 id
        const result = await pool.query(`
            INSERT INTO test_results (
                timestamp, session_id, drink_name,
                E, V, S, D, e_idx, v_idx, s_idx, d_idx,
                device, screen_size, user_agent, ip_address
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            RETURNING id
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
        ]);

        const resultId = result.rows[0].id;

        // 插入答案
        for (let i = 0; i < data.answers.length; i++) {
            await pool.query(`
                INSERT INTO test_answers (result_id, question_index, answer_value)
                VALUES ($1, $2, $3)
            `, [resultId, i, data.answers[i]]);
        }

        res.json({
            success: true,
            message: '数据保存成功',
            id: resultId
        });
    } catch (err) {
        console.error('保存失败:', err);
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// ==================== 统计 API ====================
app.get('/api/stats', async (req, res) => {
    const key = req.query.key;
    if (key !== 'admin123') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
        const result = await pool.query(`
            SELECT 
                COUNT(*) as total_tests,
                AVG(E) as avg_E,
                AVG(V) as avg_V,
                AVG(S) as avg_S,
                AVG(D) as avg_D,
                (
                    SELECT drink_name 
                    FROM test_results 
                    GROUP BY drink_name 
                    ORDER BY COUNT(*) DESC 
                    LIMIT 1
                ) as most_common_drink
            FROM test_results
        `);
        res.json(result.rows[0] || {});
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== 列表 API ====================
app.get('/api/results', async (req, res) => {
    const key = req.query.key;
    if (key !== 'admin123') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const limit = parseInt(req.query.limit) || 20;
    try {
        const result = await pool.query(`
            SELECT id, timestamp, drink_name, E, V, S, D, device
            FROM test_results 
            ORDER BY id DESC 
            LIMIT $1
        `, [limit]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== 管理面板 ====================
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

// ==================== 启动服务器 ====================
app.listen(PORT, () => {
    console.log('🚀 服务器已启动: http://localhost:' + PORT);
    console.log('📊 管理面板: http://localhost:' + PORT + '/admin');
    console.log('🔑 默认密码: admin123');
});
