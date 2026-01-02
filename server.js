const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cron = require('node-cron');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'idx_data.json');
const USER_DATA_DIR = path.join(__dirname, 'browser_session');
const API_SECRET = process.env.API_SECRET || 'your-secure-api-key'; // Use Env Var for safer deployment

// Ensure session directory exists
if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR);
}

// Add stealth plugin
puppeteer.use(StealthPlugin());

app.use(cors());

// Rotation User Agents
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
];

/**
 * Checks if current time is within valid trading hours (Mon-Fri, 09:00 - 16:00 approx).
 * Used to prevent accidental manual triggers or off-hour scraping.
 */
function isTradingHours() {
    const now = new Date();
    // 0 = Sunday, 6 = Saturday
    const day = now.getDay();
    const hour = now.getHours();

    // Weekend guard
    if (day === 0 || day === 6) return false;

    // Hour guard (09:00 to 15:59)
    if (hour < 9 || hour >= 16) return false;

    return true;
}

// --- Scraper Function ---
async function fetchIdxData(force = false) {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    // Hard Guard: Skip if not trading hours (unless forced)
    if (!force && !isTradingHours()) {
        console.log(`[${timestamp}] SKIPPING fetch: Outside trading hours/days.`);
        return { status: 'skipped', message: 'Outside trading hours' };
    }

    console.log(`[${timestamp}] Starting fetch sequence...`);
    let browser;

    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: USER_DATA_DIR, // Persistence
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        // Randomize User Agent
        const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
        await page.setUserAgent(randomUserAgent);

        // URL for Stock Summary
        const url = 'https://www.idx.co.id/primary/TradingSummary/GetStockSummary';

        // Go to the URL with randomized loose timeout
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });

        // Extract JSON
        const content = await page.evaluate(() => document.body.innerText);
        const json = JSON.parse(content);

        // Transform data
        let stocks = [];
        if (json && json.data && Array.isArray(json.data)) {
            stocks = json.data.map(item => {
                const close = item.Close;
                const prev = item.Previous;
                const change = item.Change;
                let changePct = 0;
                if (prev !== 0) {
                    changePct = parseFloat(((change / prev) * 100).toFixed(2));
                }
                return {
                    Code: item.StockCode,
                    Name: item.StockName,
                    Previous: prev,
                    High: item.High,
                    Low: item.Low,
                    Last: close,
                    Change: change,
                    ChangePct: changePct
                };
            });
        } else {
            throw new Error('Invalid JSON structure from IDX');
        }

        const result = {
            LastUpdate: timestamp,
            TotalItems: stocks.length,
            Stocks: stocks
        };

        // Save to file (Atomic write safety)
        // Check if data is valid before overwriting
        if (stocks.length > 0) {
            fs.writeFileSync(DATA_FILE, JSON.stringify(result, null, 2));
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            console.log(`[${timestamp}] FETCH SUCCESS. ${stocks.length} stocks. Duration: ${duration}s`);
            return { status: 'success', count: stocks.length };
        } else {
            console.warn(`[${timestamp}] FETCH WARNING: No stocks found. Keeping old data.`);
            return { status: 'warning', message: 'Empty data' };
        }

    } catch (error) {
        const errorDuration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.error(`[${timestamp}] FETCH FAILED: ${error.message} (${errorDuration}s)`);
        console.log(`[${timestamp}] Fallback: Serving previous data if available.`);
        return { status: 'error', message: error.message };
    } finally {
        if (browser) await browser.close();
    }
}

// --- Scheduler ---
// Run every hour between 09:00 and 15:00, ONLY on weekdays (Monday-Friday)
// Cron format: Minute Hour DayMonth Month DayWeek (1-5 = Mon-Fri)
cron.schedule('5 9-15 * * 1-5', () => {
    const randomDelay = Math.floor(Math.random() * 300000); // 0-5 mins jitter
    console.log(`[Scheduler] Triggered. Jitter delay: ${randomDelay / 1000}s`);

    setTimeout(() => {
        fetchIdxData(); // Standard fetch (obeys hours guard)
    }, randomDelay);
});

// --- API Endpoints ---

app.get('/', (req, res) => {
    res.send('<h1>IDX Scraper API</h1><p>Data available at <a href="/api/idx-data">/api/idx-data</a></p>');
});

app.get('/api/idx-data', (req, res) => {
    if (fs.existsSync(DATA_FILE)) {
        // Fallback: Always serve the file content, even if latest fetch failed.
        // The file is only overwritten on SUCCESS.
        const data = fs.readFileSync(DATA_FILE, 'utf8');
        res.json(JSON.parse(data));
    } else {
        res.status(503).json({ error: 'Data initializing. Please wait.' });
    }
});

// Protected Manual Trigger
// Usage: /api/trigger-fetch?key=your-secure-api-key&force=true
app.get('/api/trigger-fetch', async (req, res) => {
    const authKey = req.query.key;
    const force = req.query.force === 'true';

    if (authKey !== API_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    console.log(`[Manual Trigger] Request received (Force: ${force})`);
    const result = await fetchIdxData(force);
    res.json(result);
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    // Initial fetch on startup (if no file exists, force run to populate)
    if (!fs.existsSync(DATA_FILE)) {
        console.log('Initial startup fetch...');
        fetchIdxData(true);
    }
});
