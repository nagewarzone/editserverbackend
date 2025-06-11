const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const app = express();
const axios = require('axios');
const port = 3000;

app.use(cors());
app.use(express.json());

// ENV-like config (ใช้ dotenv ก็ได้)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const AUTH_TOKEN = process.env.AUTH_TOKEN;


// Auth middleware
function authMiddleware(req, res, next) {
  const token = req.headers['authorization'];
  if (token === `Bearer ${AUTH_TOKEN}`) {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden' });
  }
}

const dbConfig = {
  user: 'sa',
  password: 'Nage12345',
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
};
// เพิ่ม route สำหรับเช็ค public IP
app.get('/api/myip', async (req, res) => {
  try {
    const response = await axios.get('https://api.ipify.org?format=json');
    res.json({ ip: response.data.ip });
  } catch (error) {
    console.error('Failed to get public IP:', error);
    res.status(500).json({ error: 'Failed to get public IP' });
  }
});
// ✅ LOGIN endpoint
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    return res.json({ success: true, token: AUTH_TOKEN });
  }
  res.status(401).json({ success: false, error: 'Unauthorized' });
});

// ✅ GET: item list — No auth
app.get('/api/items', authMiddleware, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const search = req.query.search || '';
  const pageSize = 50;
  const startRow = (page - 1) * pageSize + 1;
  const endRow = page * pageSize;

  try {
    await sql.connect(dbConfig);
    const request = new sql.Request();
    request.input('search', sql.NVarChar, `%${search}%`);
    request.input('startRow', sql.Int, startRow);
    request.input('endRow', sql.Int, endRow);

    const query = `
      WITH OrderedItems AS (
        SELECT *,
               ROW_NUMBER() OVER (ORDER BY ItemID) AS RowNum
        FROM dbo.iteminfo
        WHERE (@search = '' OR ItemName LIKE @search)
      ),
      CountItems AS (
        SELECT COUNT(*) AS TotalCount
        FROM dbo.iteminfo
        WHERE (@search = '' OR ItemName LIKE @search)
      )
      SELECT oi.*, ci.TotalCount
      FROM OrderedItems oi
      CROSS JOIN CountItems ci
      WHERE oi.RowNum BETWEEN @startRow AND @endRow
      ORDER BY oi.RowNum
    `;

    const result = await request.query(query);
    const items = result.recordset;
    if (items.length === 0) {
      return res.json({ items: [], totalPages: 1 });
    }
    const totalCount = items[0].TotalCount;
    const totalPages = Math.ceil(totalCount / pageSize);
    const cleaned = items.map(({ TotalCount, ...rest }) => rest);
    res.json({ items: cleaned, totalPages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ✅ POST: update items — ต้อง login
app.post('/api/items/updateBatch', authMiddleware, async (req, res) => {
  const { updates } = req.body;

  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: 'Invalid updates data' });
  }

  const invalidCols = ['RowNum'];

  try {
    await sql.connect(dbConfig);
    const transaction = new sql.Transaction();
    await transaction.begin();

    try {
      for (const item of updates) {
        const { ItemID, ...fields } = item;
        if (!ItemID || typeof ItemID !== 'number') continue;

        const setClauses = [];
        const req = new sql.Request(transaction);

        for (const col in fields) {
          const val = fields[col];
          if (val != null && !invalidCols.includes(col)) {
            setClauses.push(`[${col}] = @${col}`);
            if (typeof val === 'number' && Number.isInteger(val)) {
              req.input(col, sql.Int, val);
            } else if (typeof val === 'number') {
              req.input(col, sql.Float, val);
            } else {
              req.input(col, sql.NVarChar(sql.MAX), val);
            }
          }
        }

        if (setClauses.length === 0) continue;

        req.input('ItemID', sql.Int, ItemID);
        const updateSql = `
          UPDATE dbo.iteminfo
          SET ${setClauses.join(', ')}
          WHERE ItemID = @ItemID
        `;
        const result = await req.query(updateSql);
        if (result.rowsAffected[0] === 0) {
          await transaction.rollback();
          return res.status(404).json({ error: `ItemID ${ItemID} not found` });
        }
      }

      await transaction.commit();
      res.json({ success: true });
    } catch (e) {
      await transaction.rollback();
      console.error('Batch update error:', e);
      res.status(500).json({ error: 'Batch update failed' });
    }
  } catch (err) {
    console.error('DB connection error:', err);
    res.status(500).json({ error: 'Database connection error' });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
