const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

puppeteer.use(StealthPlugin());

// Paths (Using process.cwd() is safer in CI)
const DATA_FILE = path.join(process.cwd(), 'idx_data.json');
const GOLD_DATA_FILE = path.join(process.cwd(), 'gold_data.json');
const CRYPTO_DATA_FILE = path.join(process.cwd(), 'crypto_data.json');
const ALL_DATA_FILE = path.join(process.cwd(), 'all_data.json');
const USER_DATA_DIR = path.join(process.cwd(), '.gh_temp_session');

// Ensure temp dir
if (!fs.existsSync(USER_DATA_DIR)) {
    try { fs.mkdirSync(USER_DATA_DIR, { recursive: true }); } catch (e) { }
}

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

async function fetchCryptoData(timestamp) {
    try {
        console.log('Fetching Crypto (Indodax)...');
        const response = await axios.get('https://indodax.com/api/summaries', { timeout: 20000 });
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

async function runScraper() {
    try {
        const args = process.argv.slice(2);
        const targetArg = args.find(arg => arg.startsWith('--target='));
        const target = targetArg ? targetArg.split('=')[1] : 'all';

        console.log(`Starting Scraper (Docker Mode). Target: ${target}`);
        const timestamp = new Date().toISOString();

        const scrapeStocks = target === 'stocks' || target === 'all';
        const scrapeGold = target === 'gold_crypto' || target === 'all';
        const scrapeCrypto = target === 'gold_crypto' || target === 'all';

        if (scrapeCrypto) await fetchCryptoData(timestamp);

        if (scrapeStocks || scrapeGold) {
            let browser = null;
            try {
                browser = await puppeteer.launch({
                    headless: "new",
                    userDataDir: USER_DATA_DIR,
                    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || 'google-chrome-stable',
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-gpu',
                        '--no-first-run',
                        '--single-process'
                    ]
                });

                // --- STOCKS ---
                if (scrapeStocks) {
                    try {
                        console.log('SCRAPING STOCKS...');
                        const page = await browser.newPage();
                        await page.setRequestInterception(true);
                        page.on('request', (req) => {
                            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
                            else req.continue();
                        });
                        await page.setUserAgent(USER_AGENTS[0]);
                        await page.goto('https://www.idx.co.id/primary/TradingSummary/GetStockSummary', { waitUntil: 'networkidle2', timeout: 90000 });

                        const rawData = await page.evaluate(() => {
                            const bodyTxt = document.body.innerText.trim();
                            if (bodyTxt && (bodyTxt.startsWith('{') || bodyTxt.startsWith('['))) return bodyTxt;
                            const pre = document.querySelector('pre');
                            return pre ? pre.innerText.trim() : document.body.innerHTML;
                        });

                        let json;
                        try {
                            json = JSON.parse(rawData);
                        } catch (e) {
                            const clean = rawData.replace(/<[^>]*>?/gm, '');
                            try { json = JSON.parse(clean); } catch (e2) { }
                        }

                        if (json && (json.data || json.Data)) {
                            const stocks = (json.data || json.Data).map(item => ({
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
                            console.log(`Stock Saved: ${stocks.length} items`);
                        }
                        await page.close();
                    } catch (err) { console.error('Stock Error:', err.message); }
                }

                // --- GOLD ---
                if (scrapeGold) {
                    try {
                        console.log('SCRAPING GOLD...');
                        const page = await browser.newPage();
                        await page.setUserAgent(USER_AGENTS[0]);
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
                                    const hasUBS = txt.includes('0.1') || txt.includes('0.25') || txt.includes('\n3\n') || (table.previousElementSibling?.innerText || "").toLowerCase().includes('ubs');
                                    tableType = hasUBS ? 'UBS' : 'ANTAM';
                                }

                                if (tableType === 'SPOT') {
                                    rows.forEach(row => {
                                        const cells = row.querySelectorAll('td');
                                        if (cells.length >= 3) {
                                            const unit = cells[0].innerText.trim();
                                            if (unit.match(/(Gram|Ounce|Kilogram)/)) {
                                                result.Spot.push({ Unit: unit, USD: cleanPrice(cells[1].innerText), IDR: cleanPrice(cells[2].innerText) });
                                            }
                                        }
                                    });
                                } else {
                                    rows.forEach(row => {
                                        const cells = row.querySelectorAll('td');
                                        if (cells.length >= 2 && /^[\d\.,]+$/.test(cells[0].innerText.trim())) {
                                            const weight = cleanFloat(cells[0].innerText);
                                            let price = cleanPrice(cells[1].innerText);
                                            if (price < 1000 && cells.length > 2) price = cleanPrice(cells[2].innerText);
                                            if (price > 1000) {
                                                if (tableType === 'UBS') result.UBS.push({ weight, price }); else result.Antam.push({ weight, price });
                                            }
                                        }
                                    });
                                }
                            });

                            const dedupe = (arr) => arr.filter((item, index, self) => index === self.findIndex((t) => (t.weight === item.weight))).sort((a, b) => a.weight - b.weight);
                            result.Antam = dedupe(result.Antam); result.UBS = dedupe(result.UBS);
                            return result;
                        });

                        if (goldData.Antam.length > 0) {
                            fs.writeFileSync(GOLD_DATA_FILE, JSON.stringify({ LastUpdate: timestamp, Source: 'harga-emas.org', Data: goldData }, null, 2));
                            console.log(`Gold Saved: ${goldData.Antam.length} Antam`);
                        }
                        await page.close();
                    } catch (err) { console.error('Gold Error:', err.message); }
                }

                await browser.close();
            } catch (pErr) {
                console.error('Puppeteer Launch Error:', pErr.message);
                if (browser) await browser.close();
            }
        }

        // --- MERGE ---
        const allData = {
            stocks: fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : null,
            gold: fs.existsSync(GOLD_DATA_FILE) ? JSON.parse(fs.readFileSync(GOLD_DATA_FILE, 'utf8')) : null,
            crypto: fs.existsSync(CRYPTO_DATA_FILE) ? JSON.parse(fs.readFileSync(CRYPTO_DATA_FILE, 'utf8')) : null,
            server_time: new Date().toISOString()
        };
        fs.writeFileSync(ALL_DATA_FILE, JSON.stringify(allData, null, 2));
        console.log('Merged all_data.json created.');

    } catch (e) {
        console.error('Fatal Script Error:', e);
        process.exit(1);
    }
}
runScraper();
