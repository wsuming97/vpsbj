import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

  // 验证用户给的 CCS 链接格式 + 扫描 i=0..10
  for (let i = 0; i <= 10; i++) {
    const page = await b.newPage();
    try {
      const url = `https://cloud.colocrossing.com/cart.php?a=confproduct&i=${i}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
      await sleep(3000);

      const info = await page.evaluate(() => {
        const text = document.body.innerText;
        if (text.length < 300) return { empty: true };
        
        // 提取产品名
        const nameEl = document.querySelector('.product-name, strong, h2, h3, .header-lined h2');
        // 提取价格选项
        const options = [...document.querySelectorAll('select option')].map(o => o.textContent.trim());
        // 检查缺货
        const oos = text.toLowerCase().includes('out of stock') || text.toLowerCase().includes('unavailable');
        
        return {
          name: nameEl ? nameEl.textContent.trim() : text.substring(0, 150),
          options: options.filter(o => o.includes('$')),
          oos,
          snippet: text.substring(0, 400),
        };
      });

      if (!info.empty) {
        console.log(`\n=== i=${i} ===`);
        console.log(`Name: ${info.name}`);
        console.log(`OOS: ${info.oos}`);
        if (info.options.length) console.log(`Prices: ${info.options.join(' | ')}`);
        else console.log(`Snippet: ${info.snippet.substring(0, 200)}`);
      }
    } catch (e) {
      console.log(`[i=${i}] Error: ${e.message}`);
    } finally {
      await page.close();
    }
  }
  await b.close();
}
main().catch(console.error);
