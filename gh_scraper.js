const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Initialize Stealth Plugin to evade detection
puppeteer.use(StealthPlugin());

// Paths
const DATA_FILE = path.join(__dirname, 'idx_data.json');
const GOLD_DATA_FILE = path.join(__dirname, 'gold_data.json');
const CRYPTO_DATA_FILE = path.join(__dirname, 'crypto_data.json');
const USER_DATA_DIR = path.join(__dirname, 'gh_browser_session');

// Ensure data dir exists
if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
}

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
];

// 1. CRYPTO FETCHER
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
        }
    } catch (err) {
        console.error('Crypto Fetch Error:', err.message);
    }
}

// 2. MAIN SCRAPER
async function runScraper() {
    // Parse arguments: node gh_scraper.js --target=stocks
    const args = process.argv.slice(2);
    const targetArg = args.find(arg => arg.startsWith('--target='));
    const target = targetArg ? targetArg.split('=')[1] : 'all';

    console.log(`Starting Scraper. Target: ${target}`);
    const timestamp = new Date().toISOString();

    // Determine what to scrape
    const scrapeStocks = target === 'stocks' || target === 'all';
    const scrapeGold = target === 'gold_crypto' || target === 'all';
    const scrapeCrypto = target === 'gold_crypto' || target === 'all';

    // Run Crypto independently
    if (scrapeCrypto) {
        await fetchCryptoData(timestamp);
    }

    if (!scrapeStocks && !scrapeGold) {
        console.log('No Puppeteer needed. Exiting.');
        process.exit(0);
    }

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: USER_DATA_DIR,
            // If running in GitHub Actions, use the installed Chrome path
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
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

        // --- STOCKS (IDX) ---
        if (scrapeStocks) {
            try {
                const page = await browser.newPage();
                await page.setRequestInterception(true);
                page.on('request', (req) => {
                    if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
                    else req.continue();
                });

                await page.setUserAgent(USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]);

                console.log('Navigating to IDX...');
                await page.goto('https://www.idx.co.id/primary/TradingSummary/GetStockSummary', {
                    waitUntil: 'networkidle2',
                    timeout: 90000
                });

                const rawData = await page.evaluate(() => {
                    const bodyTxt = document.body.innerText.trim();
                    if (bodyTxt && (bodyTxt.startsWith('{') || bodyTxt.startsWith('['))) return bodyTxt;
                    const pre = document.querySelector('pre');
                    if (pre) return pre.innerText.trim();
                    return document.body.innerHTML;
                });

                let json;
                try {
                    json = JSON.parse(rawData);
                } catch (e) {
                    if (rawData) {
                        const clean = rawData.replace(/<[^>]*>?/gm, '');
                        try { json = JSON.parse(clean); }
                        catch (e2) {
                            console.error('Raw IDX Response (First 200 chars):', rawData.substring(0, 200));
                        }
                    }
                }

                if (json && (json.data || json.Data) && Array.isArray(json.data || json.Data)) {
                    const stockArray = json.data || json.Data;
                    const stocks = stockArray.map(item => ({
                        Code: item.StockCode || item.stockCode,
                        Name: item.StockName || item.stockName,
                        Previous: item.Previous || item.previous,
                        High: item.High || item.high,
                        Low: item.Low || item.low,
                        Last: item.Close || item.close,
                        Change: item.Change || item.change,
                        ChangePct: (item.Previous || item.previous) !== 0 ?
                            parseFloat((((item.Change || item.change) / (item.Previous || item.previous)) * 100).toFixed(2)) : 0
                    }));

                    const result = { LastUpdate: timestamp, TotalItems: stocks.length, Stocks: stocks };
                    fs.writeFileSync(DATA_FILE, JSON.stringify(result, null, 2));
                    console.log(`Stock Fetch Success: ${stocks.length} items`);
                }
                await page.close();
            } catch (error) {
                console.error('Stock Fetch Error:', error.message);
            }
        }

        // --- GOLD ---
        if (scrapeGold) {
            try {
                const page = await browser.newPage();
                await page.setRequestInterception(true);
                page.on('request', (req) => {
                    if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
                    else req.continue();
                });

                await page.setUserAgent(USER_AGENTS[0]);
                console.log('Navigating to Harga-Emas...');
                await page.goto('https://www.harga-emas.org/', { waitUntil: 'domcontentloaded', timeout: 60000 });

                const goldData = await page.evaluate(() => {
                    const result = { Spot: [], Antam: [], UBS: [] };
                    const cleanPrice = (str) => {
                        if (!str) return 0;
                        let clean = str.split('(')[0].split(/[\n\r]/)[0].replace(/[^\d,\.]/g, '').replace(/\./g, '').replace(',', '.');
                        return parseFloat(clean);
                    };
                    const cleanFloat = (str) => parseFloat((str || "0").replace(/,/g, '.'));

                    const tables = Array.from(document.querySelectorAll('table'));
                    tables.forEach(table => {
                        const txt = table.innerText;
                        const rows = Array.from(table.querySelectorAll('tr'));
                        let tableType = 'UNKNOWN';

                        if (txt.includes('Spot Harga Emas') || txt.includes('Ounce (oz)')) tableType = 'SPOT';
                        else {
                            const hasUBSWeights = txt.includes('0.1') || txt.includes('0.25') || txt.includes('\n3\n');
                            let isHeaderUBS = false;
                            let prev = table.previousElementSibling;
                            for (let i = 0; i < 8; i++) {
                                if (!prev) break;
                                if ((prev.innerText || "").toLowerCase().includes('ubs')) { isHeaderUBS = true; break; }
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
                                        result.Spot.push({ Unit: unit, USD: cleanPrice(cells[1].innerText), IDR: cleanPrice(cells[2].innerText) });
                                    }
                                }
                            });
                        } else if (tableType === 'UBS' || tableType === 'ANTAM') {
                            rows.forEach(row => {
                                const cells = row.querySelectorAll('td');
                                if (cells.length >= 2) {
                                    const weightTxt = cells[0].innerText.trim();
                                    if (/^[\d\.,]+$/.test(weightTxt)) {
                                        const weight = cleanFloat(weightTxt);
                                        let price = cleanPrice(cells[1].innerText);
                                        if (price < 1000 && cells.length > 2) price = cleanPrice(cells[2].innerText);
                                        if (price > 1000) {
                                            if (tableType === 'UBS') result.UBS.push({ weight, price });
                                            else result.Antam.push({ weight, price });
                                        }
                                    }
                                }
                            });
                        }
                    });

                    // Dedupe
                    const sorter = (a, b) => a.weight - b.weight;
                    const dedupe = (arr) => arr.filter((item, index, self) => index === self.findIndex((t) => (t.weight === item.weight)));
                    result.Antam.sort(sorter); result.Antam = dedupe(result.Antam);
                    result.UBS.sort(sorter); result.UBS = dedupe(result.UBS);
                    return result;
                });

                if (goldData.Antam.length > 0 || goldData.Spot.length > 0) {
                    const finalOutput = { LastUpdate: timestamp, Source: 'harga-emas.org', Data: goldData };
                    fs.writeFileSync(GOLD_DATA_FILE, JSON.stringify(finalOutput, null, 2));
                    console.log(`Gold Fetch Success: ${goldData.Antam.length} Antam`);
                }
                await page.close();
            } catch (err) {
                console.error('Gold Fetch Error:', err.message);
            }
        }

    } catch (error) {
        console.error('Browser Launch Error:', error.message);
    } finally {
        if (browser) await browser.close();

        // --- MERGE ALL DATA INTO ONE FILE (all_data.json) ---
        // This allows frontend to fetch just ONE URL, similar to /api/all-data
        try {
            const allData = {
                stocks: fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : null,
                gold: fs.existsSync(GOLD_DATA_FILE) ? JSON.parse(fs.readFileSync(GOLD_DATA_FILE, 'utf8')) : null,
                crypto: fs.existsSync(CRYPTO_DATA_FILE) ? JSON.parse(fs.readFileSync(CRYPTO_DATA_FILE, 'utf8')) : null,
                server_time: new Date().toISOString()
            };
            const ALL_DATA_FILE = path.join(__dirname, 'all_data.json');
            fs.writeFileSync(ALL_DATA_FILE, JSON.stringify(allData, null, 2));
            console.log('Unified Data (all_data.json) Generated Successfully.');
        } catch (mergeErr) {
            console.error('Error generating all_data.json:', mergeErr.message);
        }

        process.exit(0);
    }
}

runScraper();
