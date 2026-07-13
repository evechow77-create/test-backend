const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: '请求过于频繁，请稍后再试' }
});
app.use('/api/save', limiter);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false, require: true }
});

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
        type_25 TEXT,           -- 新增
        category_name TEXT,     -- 新增
        category_icon TEXT,     -- 新增
        category_sub TEXT,      -- 新增
        device TEXT,
        screen_size TEXT,
        user_agent TEXT,
        ip_address TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`).catch(err => console.error('创建表失败:', err));

pool.query(`
    CREATE TABLE IF NOT EXISTS test_answers (
        id SERIAL PRIMARY KEY,
        result_id INTEGER REFERENCES test_results(id) ON DELETE CASCADE,
        question_index INTEGER,
        answer_value INTEGER
    )
`).catch(err => console.error('创建表失败:', err));

console.log('✅ PostgreSQL 已连接');

// ==================== 保存数据 ====================
app.post('/api/save', async (req, res) => {
    const data = req.body;
    const ipAddress = req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    if (!data.drink_name || !data.answers || !Array.isArray(data.answers)) {
        return res.status(400).json({ success: false, error: '缺少必要字段' });
    }

    try {
        const result = await pool.query(`
            INSERT INTO test_results (
                timestamp, session_id, drink_name,
                E, V, S, D, e_idx, v_idx, s_idx, d_idx,
                type_25, category_name, category_icon, category_sub,
                device, screen_size, user_agent, ip_address
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
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
            data.type_25 || '',        // 新增
            data.category_name || '',  // 新增
            data.category_icon || '',  // 新增
            data.category_sub || '',   // 新增
            data.device || 'unknown',
            data.screen_size || 'unknown',
            userAgent || 'unknown',
            ipAddress || 'unknown'
        ]);

        const resultId = result.rows[0].id;
        for (let i = 0; i < data.answers.length; i++) {
            await pool.query(`
                INSERT INTO test_answers (result_id, question_index, answer_value)
                VALUES ($1, $2, $3)
            `, [resultId, i, data.answers[i]]);
        }

        res.json({ success: true, message: '数据保存成功', id: resultId });
    } catch (err) {
        console.error('❌ 保存失败:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== 统计 API ====================
app.get('/api/stats', async (req, res) => {
    const key = req.query.key;
    if (key !== 'admin123') return res.status(403).json({ error: 'Unauthorized' });

    try {
        const result = await pool.query(`
            SELECT 
                COUNT(*)::int as total_tests,
                ROUND(AVG(E)::numeric, 2) as "avg_E",
                ROUND(AVG(V)::numeric, 2) as "avg_V",
                ROUND(AVG(S)::numeric, 2) as "avg_S",
                ROUND(AVG(D)::numeric, 2) as "avg_D",
                (SELECT drink_name FROM test_results GROUP BY drink_name ORDER BY COUNT(*) DESC LIMIT 1) as most_common_drink
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
    if (key !== 'admin123') return res.status(403).json({ error: 'Unauthorized' });

    const limit = parseInt(req.query.limit) || 20;
    try {
        const result = await pool.query(`
            SELECT 
                r.id, 
                r.timestamp, 
                r.drink_name, 
                r.E as "E",
                r.V as "V",
                r.S as "S",
                r.D as "D",
                r.type_25,
                r.category_name,
                r.category_icon,
                r.category_sub,
                r.device,
                array_agg(a.answer_value ORDER BY a.question_index) as answers
            FROM test_results r
            LEFT JOIN test_answers a ON r.id = a.result_id
            GROUP BY r.id
            ORDER BY r.id DESC 
            LIMIT $1
        `, [limit]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== 删除单条记录 ====================
app.delete('/api/result/:id', async (req, res) => {
    const key = req.query.key;
    if (key !== 'admin123') return res.status(403).json({ error: 'Unauthorized' });

    const id = parseInt(req.params.id);
    try {
        // ON DELETE CASCADE 会自动删除 test_answers 中的关联数据
        const result = await pool.query(`
            DELETE FROM test_results WHERE id = $1 RETURNING id
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: '记录不存在' });
        }

        res.json({ success: true, message: '删除成功', id: id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== 删除全部记录 ====================
app.delete('/api/results/all', async (req, res) => {
    const key = req.query.key;
    if (key !== 'admin123') return res.status(403).json({ error: 'Unauthorized' });

    try {
        await pool.query(`DELETE FROM test_results`);
        res.json({ success: true, message: '已删除全部记录' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== 导出 CSV ====================
app.get('/api/export', async (req, res) => {
    const key = req.query.key;
    if (key !== 'admin123') return res.status(403).json({ error: 'Unauthorized' });

    try {
        const result = await pool.query(`
            SELECT 
                r.id, 
                r.timestamp, 
                r.drink_name, 
                r.E as "E",
                r.V as "V",
                r.S as "S",
                r.D as "D",
                r.device,
                array_agg(a.answer_value ORDER BY a.question_index) as answers
            FROM test_results r
            LEFT JOIN test_answers a ON r.id = a.result_id
            GROUP BY r.id
            ORDER BY r.id DESC
        `);

        // 构建CSV
        let csv = 'ID,时间,饮品,E,V,S,D,设备,每题分数\n';
        result.rows.forEach(r => {
            const answersStr = r.answers ? r.answers.join(';') : '';
            csv += [
                r.id,
                r.timestamp,
                r.drink_name,
                r.E ?? '',
                r.V ?? '',
                r.S ?? '',
                r.D ?? '',
                r.device || '',
                answersStr
            ].join(',') + '\n';
        });

        res.setHeader('Content-Type', 'text/csv;charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=test_data_${new Date().toISOString().slice(0,10)}.csv`);
        res.send('\uFEFF' + csv); // 添加BOM让Excel正确识别UTF-8
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== 管理面板 ====================
app.get('/admin', (req, res) => {
    res.send(`<!DOCTYPE html>
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
        .btn { background: #9b7b5c; color: white; padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
        .btn:hover { background: #7f6243; }
        .btn-danger { background: #c0392b; color: white; padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
        .btn-danger:hover { background: #a93226; }
        .btn-sm { padding: 4px 10px; font-size: 12px; }
        .flex { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
        input[type="password"] { padding: 8px 12px; border: 1px solid #ddd; border-radius: 6px; }
        .answer-cell { font-size: 11px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
        .answer-cell:hover { white-space: normal; overflow: visible; background: #fff; position: relative; z-index: 10; box-shadow: 0 2px 8px rgba(0,0,0,0.15); padding: 4px 8px; border-radius: 4px; }
        .delete-btn { background: #e74c3c; color: white; border: none; border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 12px; }
        .delete-btn:hover { background: #c0392b; }
        .confirm-dialog { background: #fff3cd; padding: 12px 16px; border-radius: 8px; margin: 10px 0; border-left: 4px solid #ffc107; display: none; }
        .confirm-dialog.show { display: block; }
    </style>
</head>
<body>
    <div class="card">
        <h1>📊 测试数据管理面板</h1>
        <div style="margin: 16px 0;">
            <label>密码：</label>
            <input type="password" id="password" placeholder="输入管理员密码" value="admin123">
            <button class="btn" onclick="loadData()">加载数据</button>
            <button class="btn" onclick="exportData()">📥 导出CSV</button>
            <button class="btn btn-danger" onclick="deleteAll()">🗑️ 删除全部</button>
        </div>
        <div id="content"><p style="color:#8b7a6b;">请输入密码后点击"加载数据"</p></div>
    </div>
    <script>
        let currentData = [];

        async function loadData() {
            const pwd = document.getElementById('password').value;
            if (!pwd) { alert('请输入密码'); return; }
            const content = document.getElementById('content');
            content.innerHTML = '<p>加载中...</p>';
            try {
                const statsRes = await fetch('/api/stats?key=' + pwd);
                const stats = await statsRes.json();
                const resultsRes = await fetch('/api/results?key=' + pwd + '&limit=50');
                const results = await resultsRes.json();
                currentData = results;
                
                let html = '<div class="stats-grid">';
                html += '<div class="stat-item"><div class="stat-number">' + (stats.total_tests || 0) + '</div><div class="stat-label">总测试数</div></div>';
                html += '<div class="stat-item"><div class="stat-number">' + (stats.most_common_drink || '-') + '</div><div class="stat-label">最热门饮品</div></div>';
                html += '<div class="stat-item"><div class="stat-number">' + (stats.avg_E || '-') + '</div><div class="stat-label">平均 E 值</div></div>';
                html += '<div class="stat-item"><div class="stat-number">' + (stats.avg_V || '-') + '</div><div class="stat-label">平均 V 值</div></div>';
                html += '<div class="stat-item"><div class="stat-number">' + (stats.avg_S || '-') + '</div><div class="stat-label">平均 S 值</div></div>';
                html += '<div class="stat-item"><div class="stat-number">' + (stats.avg_D || '-') + '</div><div class="stat-label">平均 D 值</div></div>';
                html += '</div>';

                html += '<h3>📋 测试记录</h3><div style="overflow-x:auto;"><table>';
                html += '<tr><th>ID</th><th>时间</th><th>饮品</th><th>E</th><th>V</th><th>S</th><th>D</th><th>25类型</th><th>7大类</th><th>每题分数</th><th>设备</th></tr>';
                if (results && results.length > 0) {
                    results.forEach(r => {
                        const answersStr = r.answers ? r.answers.join(', ') : '无';
                        const categoryStr = (r.category_icon || '') + ' ' + (r.category_name || '') + (r.category_sub ? ' · ' + r.category_sub : '');
                        html += '<tr id="row-' + r.id + '">';
                        html += '<td>' + r.id + '</td>';
                        html += '<td>' + new Date(r.timestamp).toLocaleString() + '</td>';
                        html += '<td><strong>' + r.drink_name + '</strong></td>';
                        html += '<td>' + (r.E ?? '-') + '</td>';
                        html += '<td>' + (r.V ?? '-') + '</td>';
                        html += '<td>' + (r.S ?? '-') + '</td>';
                        html += '<td>' + (r.D ?? '-') + '</td>';
                        html += '<td>' + (r.type_25 || '-') + '</td>';
                        html += '<td>' + (categoryStr || '-') + '</td>';  
                        html += '<td class="answer-cell" title="' + answersStr + '">' + answersStr + '</td>';
                        html += '<td>' + (r.device || '-') + '</td>';
                        html += '<td><button class="delete-btn" onclick="deleteRow(' + r.id + ')">删除</button></td>';
                        html += '</tr>';
                    });
                } else {
                    html += '<tr><td colspan="10" style="text-align:center;color:#999;">暂无数据</td></tr>';
                }
                html += '</table></div>';
                html += '<div class="flex" style="margin-top:16px;"><button class="btn" onclick="loadData()">🔄 刷新</button></div>';
                content.innerHTML = html;
            } catch (e) {
                content.innerHTML = '<p style="color:red;">加载失败: ' + e.message + '</p>';
                console.error('加载失败:', e);
            }
        }

        async function deleteRow(id) {
            if (!confirm('确定要删除 ID 为 ' + id + ' 的这条记录吗？')) return;
            const pwd = document.getElementById('password').value;
            try {
                const res = await fetch('/api/result/' + id + '?key=' + pwd, { method: 'DELETE' });
                const data = await res.json();
                if (data.success) {
                    document.getElementById('row-' + id).style.display = 'none';
                    // 重新加载统计
                    loadData();
                } else {
                    alert('删除失败: ' + data.error);
                }
            } catch (e) {
                alert('删除失败: ' + e.message);
            }
        }

        async function deleteAll() {
            if (!confirm('⚠️ 确定要删除全部记录吗？此操作不可恢复！')) return;
            if (!confirm('再次确认：删除所有测试数据？')) return;
            const pwd = document.getElementById('password').value;
            try {
                const res = await fetch('/api/results/all?key=' + pwd, { method: 'DELETE' });
                const data = await res.json();
                if (data.success) {
                    alert('已删除全部记录');
                    loadData();
                } else {
                    alert('删除失败: ' + data.error);
                }
            } catch (e) {
                alert('删除失败: ' + e.message);
            }
        }

        async function exportData() {
            const pwd = document.getElementById('password').value;
            if (!pwd) { alert('请输入密码'); return; }
            window.open('/api/export?key=' + pwd, '_blank');
        }

        loadData();
    </script>
</body>
</html>`);
});

app.listen(PORT, () => {
    console.log('🚀 服务器启动: http://localhost:' + PORT);
    console.log('📊 管理面板: http://localhost:' + PORT + '/admin');
});