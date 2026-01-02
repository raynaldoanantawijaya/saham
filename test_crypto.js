const axios = require('axios');

async function testCrypto() {
    // Dynamic Date to ensure we always ask for "Today"
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 1); // Yesterday

    const strEnd = end.toISOString();
    const strStart = start.toISOString();

    // Using User's endpoint structure
    const url = `https://api-pluang.pluang.com/api/v4/asset/cryptocurrency/price/ohlcStatsByDateRange/BTC?timeFrame=FIFTEEN_MINUTES&startDate=${strStart}&endDate=${strEnd}`;

    console.log(`Testing URL: ${url}`);

    try {
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        console.log('Status:', res.status);
        console.log('Data Preview:', JSON.stringify(res.data, null, 2).substring(0, 500) + '...');

    } catch (err) {
        console.error('Error:', err.message);
        if (err.response) console.error('Response:', err.response.status, err.response.data);
    }
}

testCrypto();
