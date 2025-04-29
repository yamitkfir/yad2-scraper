const cheerio = require('cheerio');
const Telenode = require('telenode-js');
const fs = require('fs');
const config = require('./config.json');

const getYad2Response = async (url) => {
    const requestOptions = {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36'
        },
        redirect: 'follow'
    };
    try {
        const res = await fetch(url, requestOptions)
        return await res.text()
    } catch (err) {
        console.log(err)
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
    
    // Shopify product cards based on the HTML structure
    const items = [];
    
    // Target the product cards
    const productCards = $('a[class*="card_card"]');
    console.log(`Found ${productCards.length} product cards`);
    
    productCards.each((index, card) => {
        try {
            const $card = $(card);
            
            // Get product ID from href attribute
            const href = $card.attr('href') || '';
            const productId = href.split('?')[0].split('/').pop() || `product_${index}`;
            
            // Get product title
            const title = $card.find('[class*="product-title"]').text().trim() || 
                          $card.find('h3').text().trim();
            
            // Get product price
            const price = $card.find('[class*="price"]').text().trim();
            
            // Get product image
            const img = $card.find('img').attr('src') || '';
            
            // Build link
            const link = href.startsWith('http') ? 
                        href : 
                        `https://market.yad2.co.il${href}`;
            
            // Add to items if we have at least a title or price
            if (title || price) {
                items.push({
                    id: productId,
                    title,
                    price,
                    img,
                    link
                });
            }
        } catch (error) {
            console.log(`Error processing card ${index}: ${error.message}`);
        }
    });
    
    // If no products found with the card class, try another approach
    if (items.length === 0) {
        // Try looking for product preview elements
        const productElements = $('.product-preview');
        console.log(`Found ${productElements.length} product preview elements`);
        
        productElements.each((index, element) => {
            try {
                const $element = $(element);
                
                const linkElement = $element.find('a').first();
                const href = linkElement.attr('href') || '';
                const productId = href.split('?')[0].split('/').pop() || `product_${index}`;
                
                const title = $element.find('h3, .product-title, [class*="title"]').first().text().trim();
                const price = $element.find('.price, [class*="price"]').first().text().trim();
                const img = $element.find('img').attr('src') || '';
                
                const link = href.startsWith('http') ? 
                            href : 
                            `https://market.yad2.co.il${href}`;
                
                if (title || price) {
                    items.push({
                        id: productId,
                        title,
                        price,
                        img,
                        link
                    });
                }
            } catch (error) {
                console.log(`Error processing element ${index}: ${error.message}`);
            }
        });
    }
    
    // Try one more approach if still no items
    if (items.length === 0) {
        // Look for any divs or items that might contain product info
        $('div').each((index, div) => {
            const $div = $(div);
            const classes = $div.attr('class') || '';
            
            // Only process divs that might be product containers
            if (classes.includes('product') || classes.includes('item') || classes.includes('card')) {
                try {
                    const linkElement = $div.find('a').first();
                    const href = linkElement.attr('href') || '';
                    
                    // Skip if not a product link
                    if (!href || (!href.includes('/products/') && !href.includes('product'))) {
                        return;
                    }
                    
                    const productId = href.split('?')[0].split('/').pop() || `product_${index}`;
                    
                    const title = $div.find('h3, .product-title, [class*="title"]').first().text().trim();
                    const price = $div.find('.price, [class*="price"]').first().text().trim();
                    const img = $div.find('img').attr('src') || '';
                    
                    const link = href.startsWith('http') ? 
                                href : 
                                `https://market.yad2.co.il${href}`;
                    
                    if ((title || price) && !items.some(item => item.id === productId)) {
                        items.push({
                            id: productId,
                            title,
                            price,
                            img,
                            link
                        });
                    }
                } catch (error) {
                    // Silently ignore errors for this generic approach
                }
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

const scrape = async (topic, url) => {
    const apiToken = process.env.API_TOKEN || config.API_TOKEN;
    const chatId = process.env.CHAT_ID || config.CHAT_ID;
    const telenode = new Telenode({apiToken})
    try {
        const scrapedItems = await scrapeItemsAndExtractImgUrls(url);
        console.log(`Scraped ${scrapedItems.length} items`);
        const ids = scrapedItems.map(item => item.id);
        const newIds = await checkIfHasNewItem(ids, topic);
        const newItems = scrapedItems.filter(item => newIds.includes(item.id));
        if (newItems.length > 0) {
            const newItemsJoined = newItems.map(item => 
                `כותרת: ${item.title}\nמחיר: ${item.price}\nקישור: ${item.link}`
            ).join("\n----------\n");
            
            const msg = `נמצאו ${newItems.length} פריטים חדשים:\n${newItemsJoined}`;
            await telenode.sendTextMessage(msg, chatId);
        } else {
            await telenode.sendTextMessage("לא נמצאו פריטים חדשים", chatId);
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