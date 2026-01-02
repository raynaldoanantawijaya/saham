const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

async function testGold() {
    console.log('Testing Logam Mulia Scraper...');
    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    try {
        await page.goto('https://www.logammulia.com/id', { waitUntil: 'networkidle2' });

        // Try to find price element
        // Usually .current-price or similar
        const text = await page.evaluate(() => document.body.innerText);
        const prices = text.match(/Rp\s?[\d,.]+/g);

        console.log('Found Prices:', prices ? prices.slice(0, 5) : 'None');

    } catch (e) {
        console.log('Error:', e.message);
    }

    await browser.close();
}

testGold();
