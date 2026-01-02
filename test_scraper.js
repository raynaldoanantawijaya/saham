const puppeteer = require('puppeteer');
const fs = require('fs');

async function testFetch() {
    console.log('Starting standalone fetch...');
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

        const url = 'https://www.idx.co.id/primary/StockData/GetConstituent';
        console.log(`Navigating to ${url}...`);

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        const content = await page.evaluate(() => document.body.innerText);
        console.log('Content fetched. Length:', content.length);

        try {
            const json = JSON.parse(content);
            console.log('JSON parsed successfully. Items count:', json.Items ? json.Items.length : 'N/A');
            fs.writeFileSync('test_data.json', JSON.stringify(json, null, 2));
        } catch (e) {
            console.error('Failed to parse JSON:', content.substring(0, 100));
        }

    } catch (error) {
        console.error('Fetch failed:', error);
    } finally {
        if (browser) await browser.close();
    }
}

testFetch();
