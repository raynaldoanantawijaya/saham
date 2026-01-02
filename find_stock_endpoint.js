const puppeteer = require('puppeteer');
const fs = require('fs');

async function probeEndpoints() {
    console.log('Probing potential Stock Data endpoints...');
    const endpoints = [
        'https://www.idx.co.id/primary/TradingSummary/GetStockSummary',
        'https://www.idx.co.id/primary/StockData/GetStockData',
        'https://www.idx.co.id/primary/TradingSummary/GetStockConstituent', // guess
        'https://www.idx.co.id/primary/TradingSummary/GetBrokerSummary' // just in case
    ];

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

        for (const url of endpoints) {
            console.log(`Checking: ${url}`);
            try {
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
                const content = await page.evaluate(() => document.body.innerText);
                try {
                    const json = JSON.parse(content);
                    if (json && (json.Items || json.data || Array.isArray(json))) {
                        console.log(`SUCCESS: Found valid JSON at ${url}`);
                        console.log('Sample keys:', Object.keys(json));
                        if (json.Items && json.Items.length > 0) {
                            console.log('First item sample:', json.Items[0]);
                        }
                        fs.writeFileSync('stock_data_probe.json', JSON.stringify(json, null, 2));
                        return; // Stop on first success
                    }
                } catch (e) {
                    console.log(`Failed to parse JSON from ${url}:`, e.message);
                }
            } catch (err) {
                console.log(`Error accessing ${url}:`, err.message);
            }
        }
        console.log('Probe finished. No certain match found.');

    } catch (error) {
        console.error('Probe fatal error:', error);
    } finally {
        if (browser) await browser.close();
    }
}

probeEndpoints();
