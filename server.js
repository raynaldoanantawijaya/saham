const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cron = require('node-cron');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'idx_data.json');
const GOLD_DATA_FILE = path.join(__dirname, 'gold_data.json');
const CRYPTO_DATA_FILE = path.join(__dirname, 'crypto_data.json');
const USER_DATA_DIR = path.join(__dirname, 'browser_session');
const API_SECRET = process.env.API_SECRET || 'your-secure-api-key';

if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR);
}

puppeteer.use(StealthPlugin());
app.use(cors());

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
];

async function fetchCryptoData(timestamp) {
    try {
        console.log('Fetching Crypto (Indodax)...');
        const response = await axios.get('https://indodax.com/api/summaries');
        const btc = response.data.tickers.btc_idr;
        const eth = response.data.tickers.eth_idr;
        const usdt = response.data.tickers.usdt_idr;

        if (btc) {
            const data = {
                LastUpdate: timestamp,
                Source: 'indodax.com',
                Data: [
                    { Code: 'BTC', Name: 'Bitcoin', Price: parseInt(btc.last), High: parseInt(btc.high), Low: parseInt(btc.low), Vol_IDR: parseFloat(btc.vol_idr) },
                    { Code: 'ETH', Name: 'Ethereum', Price: parseInt(eth.last), High: parseInt(eth.high), Low: parseInt(eth.low), Vol_IDR: parseFloat(eth.vol_idr) },
                    { Code: 'USDT', Name: 'Tether', Price: parseInt(usdt.last), High: parseInt(usdt.high), Low: parseInt(usdt.low), Vol_IDR: parseFloat(usdt.vol_idr) }
                ]
            };
            fs.writeFileSync(CRYPTO_DATA_FILE, JSON.stringify(data, null, 2));
            console.log('Crypto Fetch Success');
            return { status: 'success', count: 3 };
        }
    } catch (err) {
        console.error('Crypto Fetch Error:', err.message);
        return { status: 'error', message: err.message };
    }
}

// --- GLOBAL LOCK ---
let isScraping = false;

// --- Unified Scraper Logic ---
async function scrapeAllData(options = { stocks: true, gold: true, crypto: true }) {
    // 1. CONCURRENCY PROTECTION
    if (isScraping) {
        console.warn('Scraping request ignored: Job already running.');
        return { status: 'busy', message: 'Scraping in progress, please wait.' };
    }

    const startTime = Date.now();
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] Starting Fetch Sequence. Targets: Stocks=${options.stocks}, Gold=${options.gold}, Crypto=${options.crypto}`);

    // 0. FETCH CRYPTO (Parallel/Independent)
    let cryptoPromise = Promise.resolve({ status: 'skipped' });
    if (options.crypto) {
        cryptoPromise = fetchCryptoData(timestamp);
    }

    // Lock process
    isScraping = true;

    let browser;
    let stockResult = { status: 'skipped', message: 'Not requested' };
    let goldResult = { status: 'skipped', message: 'Not requested' };

    try {
        // Only launch Puppeteer if Stocks or Gold are requested
        if (options.stocks || options.gold) {
            // 2. RESOURCE OPTIMIZATION
            browser = await puppeteer.launch({
                headless: "new",
                userDataDir: USER_DATA_DIR,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process'
                ]
            });

            // -----------------------
            // 1. FETCH STOCK DATA (IDX)
            // -----------------------
            if (options.stocks) {
                try {
                    const page = await browser.newPage();
                    await page.setRequestInterception(true);
                    page.on('request', (req) => {
                        const type = req.resourceType();
                        if (['image', 'stylesheet', 'font', 'media'].includes(type)) req.abort();
                        else req.continue();
                    });

                    await page.setUserAgent(USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]);

                    console.log('Navigating to IDX...');
                    await page.goto('https://www.idx.co.id/primary/TradingSummary/GetStockSummary', {
                        waitUntil: 'networkidle2',
                        timeout: 60000
                    });

                    // IDX returns JSON in the body text or inside a <pre> tag
                    const json = await page.evaluate(() => {
                        try {
                            return JSON.parse(document.body.innerText);
                        } catch (e) { return null; }
                    }).then(async (data) => {
                        if (data) return data;
                        // Fallback
                        return await page.evaluate(() => {
                            try { return JSON.parse(document.querySelector('pre').innerText); } catch (e) { return null; }
                        });
                    });

                    if (json && json.data && Array.isArray(json.data)) {
                        const stocks = json.data.map(item => ({
                            Code: item.StockCode,
                            Name: item.StockName,
                            Previous: item.Previous,
                            High: item.High,
                            Low: item.Low,
                            Last: item.Close,
                            Change: item.Change,
                            ChangePct: item.Previous !== 0 ? parseFloat(((item.Change / item.Previous) * 100).toFixed(2)) : 0
                        }));

                        const result = { LastUpdate: timestamp, TotalItems: stocks.length, Stocks: stocks };
                        fs.writeFileSync(DATA_FILE, JSON.stringify(result, null, 2));
                        stockResult = { status: 'success', count: stocks.length };
                        console.log(`Stock Fetch Success: ${stocks.length} items`);
                    } else {
                        throw new Error('Invalid JSON structure from IDX');
                    }
                    await page.close();
                } catch (error) {
                    console.error('Stock Fetch Error:', error.message);
                    stockResult = { status: 'error', message: error.message };
                }
            }

            // -----------------------
            // 2. FETCH GOLD DATA (SOURCE: HARGA-EMAS.ORG)
            // -----------------------
            if (options.gold) {
                try {
                    const page = await browser.newPage();
                    await page.setRequestInterception(true);
                    page.on('request', (req) => {
                        const type = req.resourceType();
                        if (['image', 'stylesheet', 'font', 'media'].includes(type)) req.abort();
                        else req.continue();
                    });

                    await page.setUserAgent(USER_AGENTS[0]);
                    console.log('Navigating to Harga-Emas...');
                    await page.goto('https://www.harga-emas.org/', { waitUntil: 'domcontentloaded', timeout: 60000 });

                    const goldData = await page.evaluate(() => {
                        const result = { Spot: [], Antam: [], UBS: [] };

                        const cleanPrice = (str) => {
                            if (!str) return 0;
                            let clean = str.split('(')[0];
                            clean = clean.split(/[\n\r]/)[0];
                            clean = clean.replace(/[^\d,\.]/g, '');
                            clean = clean.replace(/\./g, '').replace(',', '.');
                            return parseFloat(clean);
                        };

                        const cleanFloat = (str) => {
                            if (!str) return 0;
                            return parseFloat(str.replace(/,/g, '.'));
                        };

                        const tables = Array.from(document.querySelectorAll('table'));
                        tables.forEach(table => {
                            const txt = table.innerText;
                            const rows = Array.from(table.querySelectorAll('tr'));
                            let tableType = 'UNKNOWN';

                            if (txt.includes('Spot Harga Emas') || txt.includes('Ounce (oz)')) {
                                tableType = 'SPOT';
                            } else {
                                const hasUBSWeights = txt.includes('0.1') || txt.includes('0.25') || txt.includes('\n3\n') || txt.includes('\n4\n');
                                let isHeaderUBS = false;
                                let prev = table.previousElementSibling;
                                for (let i = 0; i < 8; i++) {
                                    if (!prev) break;
                                    const prevTxt = (prev.innerText || "").toLowerCase();
                                    if (prevTxt.includes('ubs')) { isHeaderUBS = true; break; }
                                    prev = prev.previousElementSibling;
                                }
                                if (hasUBSWeights || isHeaderUBS) tableType = 'UBS';
                                else tableType = 'ANTAM';
                            }

                            if (tableType === 'SPOT') {
                                rows.forEach(row => {
                                    const cells = row.querySelectorAll('td');
                                    if (cells.length >= 3) {
                                        const unit = cells[0].innerText.trim();
                                        if (unit.includes('Gram') || unit.includes('Ounce') || unit.includes('Kilogram')) {
                                            result.Spot.push({
                                                Unit: unit,
                                                USD: cleanPrice(cells[1].innerText),
                                                IDR: cleanPrice(cells[2].innerText)
                                            });
                                        }
                                    }
                                });
                            } else if (tableType === 'UBS') {
                                rows.forEach(row => {
                                    const cells = row.querySelectorAll('td');
                                    if (cells.length >= 2) {
                                        const weightTxt = cells[0].innerText.trim();
                                        if (/^[\d\.,]+$/.test(weightTxt)) {
                                            const weight = cleanFloat(weightTxt);
                                            let price = cleanPrice(cells[1].innerText);
                                            if (price < 1000 && cells.length > 2) price = cleanPrice(cells[2].innerText);
                                            if (price > 1000) result.UBS.push({ weight, price });
                                        }
                                    }
                                });
                            } else if (tableType === 'ANTAM') {
                                rows.forEach(row => {
                                    const cells = row.querySelectorAll('td');
                                    if (cells.length >= 2) {
                                        const weightTxt = cells[0].innerText.trim();
                                        if (/^[\d\.,]+$/.test(weightTxt)) {
                                            const weight = cleanFloat(weightTxt);
                                            let price = cleanPrice(cells[1].innerText);
                                            if (price < 1000 && cells.length > 2) price = cleanPrice(cells[2].innerText);
                                            if (price > 1000) result.Antam.push({ weight, price });
                                        }
                                    }
                                });
                            }
                        });

                        const sorter = (a, b) => a.weight - b.weight;
                        const dedupe = (arr) => arr.filter((item, index, self) => index === self.findIndex((t) => (t.weight === item.weight)));

                        result.Antam.sort(sorter);
                        result.Antam = dedupe(result.Antam);
                        result.UBS.sort(sorter);
                        result.UBS = dedupe(result.UBS);

                        return result;
                    });

                    if (goldData.Antam.length > 0 || goldData.Spot.length > 0) {
                        const finalOutput = { LastUpdate: timestamp, Source: 'harga-emas.org', Data: goldData };
                        fs.writeFileSync(GOLD_DATA_FILE, JSON.stringify(finalOutput, null, 2));
                        goldResult = { status: 'success', source: 'harga-emas.org', counts: { Antam: goldData.Antam.length, UBS: goldData.UBS.length } };
                        console.log(`Gold Fetch Success: ${goldData.Antam.length} Antam`);
                    } else {
                        goldResult = { status: 'warning', message: 'No rows parsed' };
                    }
                    await page.close();

                } catch (err) {
                    console.error('Gold Fetch Error:', err.message);
                    goldResult = { status: 'error', message: err.message };
                }
            }
        }
    } catch (error) {
        console.error('Browser Launch Error:', error.message);
        return { status: 'fatal_error', message: error.message };
    } finally {
        if (browser) await browser.close();
        isScraping = false; // RELEASE LOCK
    }

    const cryptoResult = await cryptoPromise; // Wait for crypto

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[${timestamp}] Work Complete. Duration: ${duration}s`);

    return { timestamp, duration, stock: stockResult, gold: goldResult, crypto: cryptoResult };
}

// --- SCHEDULERS ---
// Internal schedulers removed in favor of External Cron Logic (e.g. console.cron-job.org)
// Use /api/trigger-fetch?target=stocks or ?target=gold_crypto

app.get('/', (req, res) => res.send('<h1>Scraper API</h1><p>Stocks: /api/idx-data</p><p>Gold: /api/gold-data</p><p>Crypto: /api/crypto-data</p>'));

app.get('/api/idx-data', (req, res) => {
    if (fs.existsSync(DATA_FILE)) res.json(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
    else res.status(503).json({ error: 'Data initializing.' });
});

app.get('/api/gold-data', (req, res) => {
    if (fs.existsSync(GOLD_DATA_FILE)) res.json(JSON.parse(fs.readFileSync(GOLD_DATA_FILE, 'utf8')));
    else res.status(503).json({ error: 'Data initializing.' });
});

app.get('/api/crypto-data', (req, res) => {
    if (fs.existsSync(CRYPTO_DATA_FILE)) res.json(JSON.parse(fs.readFileSync(CRYPTO_DATA_FILE, 'utf8')));
    else res.status(503).json({ error: 'Data initializing.' });
});

// --- Unified Endpoint ---
app.get('/api/all-data', (req, res) => {
    const response = {
        stocks: null,
        gold: null,
        crypto: null,
        server_time: new Date().toISOString()
    };

    if (fs.existsSync(DATA_FILE)) {
        response.stocks = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }

    if (fs.existsSync(GOLD_DATA_FILE)) {
        response.gold = JSON.parse(fs.readFileSync(GOLD_DATA_FILE, 'utf8'));
    }

    if (fs.existsSync(CRYPTO_DATA_FILE)) {
        response.crypto = JSON.parse(fs.readFileSync(CRYPTO_DATA_FILE, 'utf8'));
    }

    res.json(response);
});

app.get('/api/trigger-fetch', async (req, res) => {
    if (req.query.key !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    const target = req.query.target; // 'stocks', 'gold_crypto', or 'all' (default)

    let options = { stocks: true, gold: true, crypto: true }; // Default ALL

    if (target === 'stocks') {
        options = { stocks: true, gold: false, crypto: false };
    } else if (target === 'gold_crypto') {
        options = { stocks: false, gold: true, crypto: true };
    }

    console.log(`[API Trigger] Fetching with target: ${target || 'all'}`);
    const result = await scrapeAllData(options);
    res.json(result);
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    // Check if ANY data file is missing (Stock, Gold, OR Crypto) to do initial fetch
    const missingStock = !fs.existsSync(DATA_FILE);
    const missingGold = !fs.existsSync(GOLD_DATA_FILE);
    const missingCrypto = !fs.existsSync(CRYPTO_DATA_FILE);

    if (missingStock || missingGold || missingCrypto) {
        console.log('Initial data missing. Running targeted fetch...');
        scrapeAllData({
            stocks: missingStock,
            gold: missingGold,
            crypto: missingCrypto
        });
    }
});
