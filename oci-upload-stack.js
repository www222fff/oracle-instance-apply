// 用 CDP Chrome 直接打开 Stack 的编辑页，上传新的 Terraform zip 并保存（不会勾选 Run apply）。
// 用法：node oci-upload-stack.js <stack-ocid> <region> <zip 路径（Chrome 所在系统能访问的路径）>
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = process.env.OCI_APPLY_CONFIG || path.join(__dirname, 'config.json');
const CDP_URL = (fs.existsSync(CONFIG_FILE) && JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).cdpUrl) || 'http://127.0.0.1:9222';
const [stackOcid, region, zipPath] = process.argv.slice(2);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function findFrame(page, predicate, arg, tries = 45) {
    for (let i = 0; i < tries; i++) {
        for (const frame of page.frames()) {
            // frame 已 detached 时 evaluate 是同步抛错，链式 .catch() 接不住。
            try {
                if (await frame.evaluate(predicate, arg)) return frame;
            } catch {}
        }
        await sleep(2000);
    }
    throw new Error('页面元素没有出现');
}

async function clickText(page, selector, text, tries = 45) {
    const visible = ({ selector, text }) => [...document.querySelectorAll(selector)]
        .some(node => node.innerText && node.innerText.trim() === text && node.getClientRects().length > 0);
    // 控制台切换新旧版界面时 frame 会被销毁，遇到 detached 就重新找。
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const frame = await findFrame(page, visible, { selector, text }, tries);
            const handle = await frame.evaluateHandle(({ selector, text }) => [...document.querySelectorAll(selector)]
                .filter(node => node.innerText && node.innerText.trim() === text && node.getClientRects().length > 0).pop(), { selector, text });
            await handle.asElement().click();
            console.log('clicked', text);
            return;
        } catch (error) {
            if (!/detached|destroyed/i.test(error.message) || attempt === 2) throw error;
            await sleep(3000);
        }
    }
}

async function main() {
    if (!stackOcid || !region || !zipPath) {
        console.error('用法：node oci-upload-stack.js <stack-ocid> <region> <zip-path>');
        process.exit(2);
    }
    const zipName = zipPath.split(/[\\/]/).pop();
    const target = await (await fetch(`${CDP_URL}/json/new?about:blank`, { method: 'PUT' })).json();
    const browser = await puppeteer.connect({
        browserURL: CDP_URL,
        defaultViewport: null,
        targetFilter: t => t.type() !== 'page' || t._targetId === target.id,
    });
    const page = (await browser.pages())[0];
    // 后台标签页里 OCI 控制台的 iframe 不渲染正文。
    await page.bringToFront();
    try {
        await page.goto(`https://cloud.oracle.com/resourcemanager/stacks/${stackOcid}/edit?fromStack=1&region=${region}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
        const frame = await findFrame(page, () => !!document.querySelector('input[type=file]'));
        await sleep(3000);
        const input = await frame.evaluateHandle(() => document.querySelector('input[type=file]'));
        await input.asElement().uploadFile(zipPath);
        await sleep(4000);
        if (!await frame.evaluate(name => document.body.innerText.includes(name), zipName)) throw new Error('zip 没有被表单接收');
        console.log('zip accepted');

        await clickText(page, 'button', 'Next');
        await sleep(6000);
        await clickText(page, 'button', 'Next');
        await sleep(6000);
        const runApply = await frame.evaluate(() => [...document.querySelectorAll('input[type=checkbox]')]
            .some(box => /Run apply/.test(box.labels?.[0]?.innerText || '') && box.checked));
        if (runApply) throw new Error('Run apply 被勾选了，已中止');
        await clickText(page, 'button', 'Save changes');
        await sleep(15000);
        console.log('saved');
    } finally {
        await browser.disconnect().catch(() => {});
        await fetch(`${CDP_URL}/json/close/${target.id}`).catch(() => {});
    }
}

main().catch(error => {
    console.error('ERROR', error.message);
    process.exit(1);
});
