const cheerio = require('cheerio');
const Telenode = require('telenode-js');
const fs = require('fs');
const config = require('./config.json');

const getYad2Response = async (url) => {
    const requestOptions = {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
            'Cache-Control': 'no-cache'
        },
        redirect: 'follow'
    };
    
    try {
        console.log(`Fetching URL: ${url}`);
        const res = await fetch(url, requestOptions);
        console.log(`Response status: ${res.status}`);
        
        if (!res.ok) {
            throw new Error(`HTTP error! Status: ${res.status}`);
        }
        
        return await res.text();
    } catch (err) {
        console.error('Error fetching URL:', err);
        throw err;
    }
}

const scrapeItemsAndExtractImgUrls = async (url) => {
    console.log('Starting scraping process...');
    
    try {
        const yad2Html = await getYad2Response(url);
        
        if (!yad2Html) {
            throw new Error("Empty response from Yad2");
        }
        
        // Save HTML for debugging
        fs.writeFileSync('last_response.html', yad2Html);
        console.log('Saved response HTML to last_response.html for debugging');

        const $ = cheerio.load(yad2Html);
        const titleText = $("title").first().text();
        console.log(`Page title: "${titleText}"`);
        
        if (titleText === "ShieldSquare Captcha") {
            throw new Error("Bot detection triggered");
        }
        
        // Try different selectors based on Yad2's current structure
        // Option 1: Original selectors
        let itemElements = $(".feeditem");
        
        // Option 2: Try alternative selectors if no items found
        if (itemElements.length === 0) {
            console.log('No items found with .feeditem selector, trying alternative selectors...');
            itemElements = $("[data-testid='item']");
        }
        
        // Option 3: Another alternative
        if (itemElements.length === 0) {
            console.log('Trying another selector pattern...');
            itemElements = $(".feed_item");
        }
        
        console.log(`Found ${itemElements.length} item elements on the page`);
        
        const items = [];

        itemElements.each((i, el) => {
            try {
                const $el = $(el);
                const id = $el.attr("post-id") || $el.attr("id") || $el.attr("data-id");
                
                // Try different selector patterns for title
                let title = $el.find(".title").text().trim();
                if (!title) title = $el.find("[data-testid='item-title']").text().trim();
                if (!title) title = $el.find("h3").text().trim();
                
                // Try different selector patterns for price
                let price = $el.find(".price").text().trim();
                if (!price) price = $el.find("[data-testid='item-price']").text().trim();
                if (!price) price = $el.find(".PriceRow_price__JXzgL").text().trim();
                
                // Try different selector patterns for image
                let img = $el.find("img").attr("src") || "";
                if (!img) img = $el.find("[data-testid='item-image']").attr("src") || "";
                
                // Try different selector patterns for link
                let link = $el.find("a").attr("href") || "";
                if (!link) link = $el.attr("data-href") || "";
                if (!link && $el.parent().is("a")) link = $el.parent().attr("href") || "";
                
                if (link && !link.startsWith("http")) {
                    link = `https://market.yad2.co.il${link}`;
                }
                
                const itemId = id || `${title}_${price}`.replace(/\s+/g, '_');
                
                console.log(`Item ${i+1}: ID=${itemId}, Title=${title}, Price=${price}`);
                
                items.push({
                    id: itemId,
                    title,
                    price,
                    img,
                    link
                });
            } catch (err) {
                console.error(`Error processing item ${i+1}:`, err);
            }
        });

        return items;
    } catch (err) {
        console.error('Error in scraping function:', err);
        throw err;
    }
};

const checkIfHasNewItem = async (ids, topic) => {
    console.log(`Checking for new items for topic: ${topic}`);
    console.log(`Received IDs: ${JSON.stringify(ids)}`);
    
    const filePath = `./data/${topic}.json`;
    let savedIds = [];
    
    try {
        if (!fs.existsSync('./data')) {
            console.log('Creating data directory...');
            fs.mkdirSync('./data', { recursive: true });
        }
        
        if (fs.existsSync(filePath)) {
            const fileContent = fs.readFileSync(filePath, 'utf8');
            savedIds = JSON.parse(fileContent);
            console.log(`Loaded ${savedIds.length} saved IDs from ${filePath}`);
        } else {
            console.log(`File ${filePath} doesn't exist, will create it`);
            fs.writeFileSync(filePath, '[]');
        }
    } catch (e) {
        console.error(`Error reading/creating ${filePath}:`, e);
        // Initialize as empty if there was an error
        savedIds = [];
        fs.writeFileSync(filePath, '[]');
    }
    
    let shouldUpdateFile = false;
    const filteredIds = savedIds.filter(savedId => {
        const exists = ids.includes(savedId);
        if (!exists) {
            shouldUpdateFile = true;
            console.log(`ID ${savedId} no longer exists in current results`);
        }
        return exists;
    });
    
    const newItems = [];
    ids.forEach(id => {
        if (!savedIds.includes(id)) {
            filteredIds.push(id);
            newItems.push(id);
            shouldUpdateFile = true;
            console.log(`Found new item with ID: ${id}`);
        }
    });
    
    if (shouldUpdateFile) {
        console.log(`Updating ${filePath} with ${filteredIds.length} IDs`);
        const updatedIds = JSON.stringify(filteredIds, null, 2);
        fs.writeFileSync(filePath, updatedIds);
        await createPushFlagForWorkflow();
    } else {
        console.log('No changes detected, file not updated');
    }
    
    return newItems;
}

const createPushFlagForWorkflow = () => {
    console.log('Creating push flag for GitHub workflow');
    fs.writeFileSync("push_me", "");
}

const formatItemForTelegram = (item) => {
    return `🔍 Title: ${item.title}
💰 Price: ${item.price}
🔗 Link: ${item.link}
${item.img ? '📷 Image: ' + item.img : ''}`;
}

const scrape = async (topic, url) => {
    console.log(`\n=== Starting scrape for topic: ${topic} ===`);
    console.log(`URL: ${url}`);
    
    const apiToken = process.env.API_TOKEN || config.API_TOKEN;
    const chatId = process.env.CHAT_ID || config.CHAT_ID;
    
    if (!apiToken) {
        throw new Error("Telegram API token not found in environment or config");
    }
    
    if (!chatId) {
        throw new Error("Telegram chat ID not found in environment or config");
    }
    
    console.log(`Using Telegram API token: ${apiToken.substring(0, 5)}...`);
    console.log(`Using chat ID: ${chatId}`);
    
    const telenode = new Telenode({apiToken});
    
    try {
        const scrapedItems = await scrapeItemsAndExtractImgUrls(url);
        console.log(`Scraped ${scrapedItems.length} items`);
        
        const ids = scrapedItems.map(item => item.id);
        const newIds = await checkIfHasNewItem(ids, topic);
        const newItems = scrapedItems.filter(item => newIds.includes(item.id));
        
        console.log(`Found ${newItems.length} new items`);
        
        if (newItems.length > 0) {
            // Send items one by one for better readability in Telegram
            for (const item of newItems) {
                const formattedItem = formatItemForTelegram(item);
                await telenode.sendTextMessage(formattedItem, chatId);
                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            await telenode.sendTextMessage(`✅ Found ${newItems.length} new camera listings!`, chatId);
        } else {
            await telenode.sendTextMessage("🔍 No new camera listings found", chatId);
        }
    } catch (e) {
        console.error('Error in scrape function:', e);
        let errMsg = e?.message || "Unknown error";
        await telenode.sendTextMessage(`❌ Scan failed:\n${errMsg}`, chatId);
        throw e;
    }
}

const program = async () => {
    console.log('Starting Yad2 scraper...');
    console.log(`Date and time: ${new Date().toISOString()}`);
    
    try {
        await Promise.all(config.projects.filter(project => {
            if (project.disabled) {
                console.log(`Topic "${project.topic}" is disabled. Skipping.`);
            }
            return !project.disabled;
        }).map(async project => {
            await scrape(project.topic, project.url);
        }));
        
        console.log('Scraping completed successfully');
    } catch (error) {
        console.error('Error in main program:', error);
        process.exit(1);
    }
};

// If this file is run directly
if (require.main === module) {
    program();
}

// Export functions for testing
module.exports = {
    getYad2Response,
    scrapeItemsAndExtractImgUrls,
    checkIfHasNewItem,
    scrape,
    program
};