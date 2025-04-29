const cheerio = require('cheerio');
const Telenode = require('telenode-js');
const fs = require('fs');
const config = require('./config.json');

const getYad2Response = async (url) => {
    const requestOptions = {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Referer': 'https://market.yad2.co.il/'
        },
        redirect: 'follow'
    };
    try {
        const res = await fetch(url, requestOptions);
        return await res.text();
    } catch (err) {
        console.log(err);
    }
}

const scrapeItemsAndExtractImgUrls = async (url) => {
    const yad2Html = await getYad2Response(url);
    if (!yad2Html) {
        throw new Error("Could not get Yad2 response");
    }

    // For debugging
    fs.writeFileSync('last_response.html', yad2Html);
    
    const $ = cheerio.load(yad2Html);
    const titleText = $("title").first().text();
    if (titleText === "ShieldSquare Captcha") {
        throw new Error("Bot detection");
    }
    
    console.log(`Page title: "${titleText}"`);
    
    // Yad2 specific selectors
    const items = [];
    
    // Try to find the main feed items
    const feedItems = $(".feed_item, .feeditem, [data-test-id='feed-item'], li[item-id]");
    console.log(`Found ${feedItems.length} feed items`);
    
    if (feedItems.length > 0) {
        feedItems.each((index, el) => {
            try {
                const $el = $(el);
                
                // Get ID from various possible attributes
                const id = $el.attr('item-id') || $el.attr('data-item-id') || $el.attr('id') || 
                          $el.attr('post-id') || `item_${index}`;
                
                // Try various selectors for title
                const title = $el.find(".title, [data-test-id='item-title'], h3, .item-title").first().text().trim() ||
                              $el.find("h2").first().text().trim();
                
                // Try various selectors for price
                const price = $el.find(".price, [data-test-id='item-price'], .item-price").first().text().trim();
                
                // Try to find image
                const img = $el.find("img").first().attr('src') || 
                            $el.find("img").first().attr('data-src') || '';
                
                // Try to find link
                let link = $el.find("a").first().attr('href') || '';
                // Make sure link is absolute
                if (link && !link.startsWith('http')) {
                    link = `https://market.yad2.co.il${link.startsWith('/') ? '' : '/'}${link}`;
                }
                
                // Add item if we have at least some info
                if (id && (title || price)) {
                    items.push({
                        id,
                        title,
                        price,
                        img,
                        link
                    });
                }
            } catch (error) {
                console.log(`Error processing item ${index}: ${error.message}`);
            }
        });
    }
    
    // If no items found, try a different approach with general product elements
    if (items.length === 0) {
        // Try to find any elements that might contain product information
        // This is a more generic approach looking for common product listing patterns
        const potentialItems = $('div[class*="item"], div[class*="product"], div[class*="card"]');
        console.log(`Found ${potentialItems.length} potential items`);
        
        potentialItems.each((index, el) => {
            try {
                const $el = $(el);
                
                if ($el.find('a').length === 0) return; // Skip if no links
                
                const id = $el.attr('id') || $el.attr('data-id') || `generic_${index}`;
                
                // Look for text that might be a title
                const title = $el.find('h2, h3, h4, [class*="title"], [class*="name"]').first().text().trim();
                
                // Look for text that might be a price
                const price = $el.find('[class*="price"], [class*="cost"], strong').first().text().trim();
                
                // Find image
                const img = $el.find('img').first().attr('src') || 
                            $el.find('img').first().attr('data-src') || '';
                
                // Find link
                let link = $el.find('a').first().attr('href') || '';
                if (link && !link.startsWith('http')) {
                    link = `https://market.yad2.co.il${link.startsWith('/') ? '' : '/'}${link}`;
                }
                
                // Add if we have meaningful data
                if (id && (title || price)) {
                    items.push({
                        id,
                        title,
                        price,
                        img,
                        link
                    });
                }
            } catch (error) {
                // Silently continue
            }
        });
    }
    
    // Last resort - grab all the items
    if (items.length === 0) {
        console.log("Using last resort method - scanning all elements");
        
        // Extract specific Yad2 structure from script tags
        const scriptTags = $('script:not([src])');
        scriptTags.each((_, script) => {
            try {
                const scriptContent = $(script).html();
                if (scriptContent && scriptContent.includes('window.__APOLLO_STATE__')) {
                    // Extract JSON data from Apollo state
                    const match = scriptContent.match(/window\.__APOLLO_STATE__\s*=\s*({.+});/);
                    if (match && match[1]) {
                        try {
                            const apolloData = JSON.parse(match[1]);
                            
                            // Look for items in Apollo data
                            Object.keys(apolloData).forEach(key => {
                                if (apolloData[key] && apolloData[key].__typename === 'Item') {
                                    const item = apolloData[key];
                                    if (item.id) {
                                        items.push({
                                            id: item.id,
                                            title: item.title || '',
                                            price: item.price || '',
                                            img: item.image_url || '',
                                            link: item.url ? `https://market.yad2.co.il${item.url}` : ''
                                        });
                                    }
                                }
                            });
                        } catch (e) {
                            console.log("Error parsing Apollo data:", e.message);
                        }
                    }
                }
            } catch (e) {
                // Continue to next script
            }
        });
    }
    
    console.log(`Total scraped items: ${items.length}`);
    
    return items;
};

const checkIfHasNewItem = async (ids, topic) => {
    const filePath = `./data/${topic}.json`;
    let savedIds = [];
    try {
        if (!fs.existsSync('./data')) {
            fs.mkdirSync('./data', { recursive: true });
        }
        
        if (fs.existsSync(filePath)) {
            const fileContent = fs.readFileSync(filePath, 'utf8');
            savedIds = JSON.parse(fileContent);
        } else {
            fs.writeFileSync(filePath, '[]');
        }
    } catch (e) {
        if (e.code === "MODULE_NOT_FOUND") {
            fs.mkdirSync('data', { recursive: true });
            fs.writeFileSync(filePath, '[]');
        } else {
            console.log(e);
            throw new Error(`Could not read / create ${filePath}`);
        }
    }
    let shouldUpdateFile = false;
    savedIds = savedIds.filter(savedId => {
        const exists = ids.includes(savedId);
        if (!exists) shouldUpdateFile = true;
        return exists;
    });
    const newItems = [];
    ids.forEach(id => {
        if (!savedIds.includes(id)) {
            savedIds.push(id);
            newItems.push(id);
            shouldUpdateFile = true;
        }
    });
    if (shouldUpdateFile) {
        const updatedIds = JSON.stringify(savedIds, null, 2);
        fs.writeFileSync(filePath, updatedIds);
        await createPushFlagForWorkflow();
    }
    return newItems;
}

const createPushFlagForWorkflow = () => {
    fs.writeFileSync("push_me", "")
}

const formatItem = (item) => {
    let formattedItem = '';
    if (item.title) formattedItem += `כותרת: ${item.title}\n`;
    if (item.price) formattedItem += `מחיר: ${item.price}\n`;
    if (item.link) formattedItem += `קישור: ${item.link}\n`;
    return formattedItem;
}

const scrape = async (topic, url) => {
    const apiToken = process.env.API_TOKEN || config.API_TOKEN;
    const chatId = process.env.CHAT_ID || config.CHAT_ID;
    const telenode = new Telenode({apiToken})
    try {
        const scrapedItems = await scrapeItemsAndExtractImgUrls(url);
        console.log(`Scraped ${scrapedItems.length} items`);
        
        if (scrapedItems.length === 0) {
            await telenode.sendTextMessage(`לא נמצאו פריטים בסריקה. אנא בדוק את קוד האתר שהשתנה.`, chatId);
            return;
        }
        
        const ids = scrapedItems.map(item => item.id);
        const newIds = await checkIfHasNewItem(ids, topic);
        const newItems = scrapedItems.filter(item => newIds.includes(item.id));
        
        if (newItems.length > 0) {
            // Split items into batches to avoid message length limits
            const BATCH_SIZE = 5;
            for (let i = 0; i < newItems.length; i += BATCH_SIZE) {
                const batchItems = newItems.slice(i, i + BATCH_SIZE);
                const newItemsJoined = batchItems.map(formatItem).join("\n----------\n");
                
                const msg = `נמצאו ${newItems.length} פריטים חדשים${newItems.length > BATCH_SIZE ? ` (מציג ${i+1}-${Math.min(i+BATCH_SIZE, newItems.length)} מתוך ${newItems.length})` : ''}:\n${newItemsJoined}`;
                await telenode.sendTextMessage(msg, chatId);
            }
        } else {
            await telenode.sendTextMessage("נסרקו פריטים, אך לא נמצאו פריטים חדשים", chatId);
        }
    } catch (e) {
        let errMsg = e?.message || "";
        if (errMsg) {
            errMsg = `שגיאה: ${errMsg}`
        }
        await telenode.sendTextMessage(`סריקה נכשלה... 😥\n${errMsg}`, chatId)
        throw new Error(e)
    }
}

const program = async () => {
    await Promise.all(config.projects.filter(project => {
        if (project.disabled) {
            console.log(`Topic "${project.topic}" is disabled. Skipping.`);
        }
        return !project.disabled;
    }).map(async project => {
        await scrape(project.topic, project.url)
    }))
};

program();