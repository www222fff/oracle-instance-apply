const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = process.env.OCI_APPLY_CONFIG || path.join(__dirname, 'config.json');

function loadConfig() {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!Array.isArray(config.stacks) || !config.stacks.length) throw new Error(`${CONFIG_FILE} 里没有配置 stacks`);
    return {
        cdpUrl: config.cdpUrl || 'http://127.0.0.1:9222',
        stateFile: path.resolve(__dirname, config.stateFile || 'state.json'),
        chromeHelper: config.chromeHelper ? path.resolve(__dirname, config.chromeHelper) : null,
        stacks: config.stacks,
    };
}

const CONFIG = loadConfig();
const CDP_URL = CONFIG.cdpUrl;
const STATE_FILE = CONFIG.stateFile;
const DEFAULT_STACKS = CONFIG.stacks;

// chromeHelper 可选：导出 ensureWindowsChrome(startUrl) / forceNoProxyEnv() 的模块，用来按需拉起 CDP Chrome。
// 不配置时只要求 cdpUrl 上已经有一个开着远程调试的 Chrome。
const chromeHelper = CONFIG.chromeHelper ? require(CONFIG.chromeHelper) : {};
const forceNoProxyEnv = chromeHelper.forceNoProxyEnv || (() => {
    process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost';
});
async function ensureChrome(startUrl) {
    if (chromeHelper.ensureWindowsChrome) return chromeHelper.ensureWindowsChrome(startUrl);
    const response = await fetch(`${CDP_URL}/json/version`).catch(() => null);
    if (!response || !response.ok) throw new Error(`连不上 Chrome 远程调试端口 ${CDP_URL}`);
}

const JOB_WAIT_MS = 12 * 60 * 1000;
const ATTENTION_REPORT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CAPACITY_REGEX = /out of (?:host )?capacity/i;
const LIMIT_REGEX = /LimitExceeded|service limit|limit exceeded|quota/i;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
    ]).finally(() => clearTimeout(timer));
}

function loadState() {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
    state.stacks = Array.isArray(state.stacks) ? state.stacks : [];
    for (const stack of DEFAULT_STACKS) {
        if (!state.stacks.some(existing => existing.ocid === stack.ocid)) state.stacks.push({ ...stack });
    }
    return state;
}

function saveState(state) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
}

function emitReport(lines) {
    console.log('OCI_FREE_REPORT_BEGIN');
    console.log(lines.join('\n'));
    console.log('OCI_FREE_REPORT_END');
}

// 需要人工处理的提醒（掉登录、非容量类失败）6 小时内同类只发一次，避免每半小时刷屏。
function reportAttention(state, key, lines) {
    state.attentionReports = state.attentionReports || {};
    const last = Date.parse(state.attentionReports[key] || '');
    if (Number.isFinite(last) && Date.now() - last < ATTENTION_REPORT_INTERVAL_MS) {
        console.log(`跳过提醒（6 小时内已提醒过）: ${lines[0]}`);
        return;
    }
    state.attentionReports[key] = new Date().toISOString();
    emitReport(lines);
}

// 每轮新开一个独立标签页，只连接这个标签页，避免被其他卡住的 OCI 标签页拖住。
async function openOwnTab() {
    const response = await fetch(`${CDP_URL}/json/new?about:blank`, { method: 'PUT' });
    const target = await response.json();
    const browser = await withTimeout(puppeteer.connect({
        browserURL: CDP_URL,
        defaultViewport: null,
        protocolTimeout: 60000,
        targetFilter: t => t.type() !== 'page' || t._targetId === target.id || t.url() === 'about:blank',
    }), 20000, 'puppeteer.connect');
    const pageTarget = browser.targets().find(t => t.type() === 'page' && (t._targetId === target.id || t.url() === 'about:blank'));
    if (!pageTarget) throw new Error('new tab target not found');
    const page = await withTimeout(pageTarget.page(), 20000, 'target.page');
    // 后台标签页里 OCI 控制台的 iframe 不渲染正文，必须切到前台。
    await page.bringToFront();
    // 关掉最后一个标签页会让 Chrome 整个退出并丢掉 Oracle 登录，所以只剩它时改为停在空白页。
    const close = async () => {
        const pages = await fetch(`${CDP_URL}/json/list`).then(r => r.json()).catch(() => []);
        const otherPages = pages.filter(item => item.type === 'page' && item.id !== target.id);
        if (otherPages.length) {
            await browser.disconnect().catch(() => {});
            await fetch(`${CDP_URL}/json/close/${target.id}`).catch(() => {});
        } else {
            await page.goto('about:blank').catch(() => {});
            await browser.disconnect().catch(() => {});
        }
    };
    return { page, close };
}

// OCI 控制台正文渲染在同源 iframe 里；返回正文里包含 marker 的那个 frame。
async function waitForConsoleFrame(page, markerRegex, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const frame of page.frames()) {
            const text = await withTimeout(frame.evaluate(() => document.body ? document.body.innerText : ''), 8000, 'frame text').catch(() => '');
            if (markerRegex.test(text)) return { frame, text };
        }
        await sleep(2000);
    }
    return null;
}

function isLoginPage(page) {
    let url;
    try { url = new URL(page.url()); } catch { return false; }
    return url.hostname !== 'cloud.oracle.com' || /sign-?in|login/i.test(url.pathname);
}

async function clickByText(frame, selector, text) {
    return frame.evaluate(({ selector, text }) => {
        const root = document.querySelector('[role=dialog]') && selector.startsWith('dialog ') ? document.querySelector('[role=dialog]') : document;
        const css = selector.replace(/^dialog /, '');
        const el = [...root.querySelectorAll(css)].find(node => node.innerText.trim() === text && !node.disabled);
        if (!el) return false;
        el.click();
        return true;
    }, { selector, text });
}

// 新版控制台把状态显示成 job 名下面的徽章（"apply-job-…\nFailed\nJob"），没有 "State" 字样。
function readJobState(text) {
    const pattern = /-job-\d+\s+(Accepted|In progress|Succeeded|Failed|Canceling|Canceled)\s+Job\b/i;
    return text.match(pattern)?.[1] || text.match(/\bState\s+(Accepted|In progress|Succeeded|Failed|Canceling|Canceled)\b/i)?.[1] || null;
}

// 日志列表是滚动加载的，要滚到底才拿得到最后的 Error。
async function readJobLogs(page) {
    const found = await waitForConsoleFrame(page, /\bLogs\b/, 30000);
    if (!found) return '';
    await clickByText(found.frame, '[role=tab]', 'Logs');
    let text = '';
    for (let i = 0; i < 15; i++) {
        await sleep(2000);
        await found.frame.evaluate(() => {
            document.querySelectorAll('*').forEach(node => {
                if (node.scrollHeight > node.clientHeight + 50) node.scrollTop = node.scrollHeight;
            });
        }).catch(() => {});
        text = await found.frame.evaluate(() => document.body.innerText).catch(() => text);
        if (CAPACITY_REGEX.test(text) || /Apply complete/i.test(text)) return text;
    }
    return text;
}

// 等 job 结束；返回 { state, url }，超时返回 state=null。
async function waitForJob(page, jobUrl) {
    if (jobUrl && page.url() !== jobUrl) {
        await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    const deadline = Date.now() + JOB_WAIT_MS;
    while (Date.now() < deadline) {
        const found = await waitForConsoleFrame(page, /-job-\d+/, 60000);
        const state = found ? readJobState(found.text) : null;
        if (state && /Succeeded|Failed|Canceled/i.test(state)) return { state, url: page.url() };
        await sleep(20000);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }
    return { state: null, url: page.url() };
}

async function handleJobResult(state, stack, page, result) {
    stack.lastJobUrl = result.url;
    stack.lastResult = result.state || 'pending';
    stack.lastCheckedAt = new Date().toISOString();

    if (!result.state) {
        console.log(`[${stack.label}] job 仍在运行，下轮继续查看: ${result.url}`);
        return;
    }
    if (/Succeeded/i.test(result.state)) {
        stack.done = true;
        stack.succeededAt = new Date().toISOString();
        stack.lastJobUrl = null;
        console.log(`[${stack.label}] Apply 成功`);
        emitReport([
            `Oracle 免费实例抢到了：${stack.label}`,
            `Stack：${stack.name}（${stack.region}）`,
            `Job：${result.url}`,
            '这个 Stack 之后不再重复 Apply。到 Compute → Instances 查看公网 IP。',
        ]);
        return;
    }

    stack.lastJobUrl = null;
    const logs = await readJobLogs(page);
    if (CAPACITY_REGEX.test(logs)) {
        console.log(`[${stack.label}] 容量不足（Out of host capacity），下轮重试`);
        stack.capacityFailures = (stack.capacityFailures || 0) + 1;
        return;
    }
    const errorLine = (logs.split('\n').find(line => /Error:/i.test(line)) || '').trim().slice(0, 200);
    if (LIMIT_REGEX.test(logs)) {
        stack.done = true;
        console.log(`[${stack.label}] 达到免费额度上限，停止重试: ${errorLine}`);
        reportAttention(state, `limit-${stack.ocid}`, [
            `Oracle 免费实例：${stack.label} 达到额度上限，已停止重试`,
            errorLine || '日志里出现了 limit / quota 相关错误。',
            `Job：${result.url}`,
        ]);
        return;
    }
    console.log(`[${stack.label}] Apply 失败（非容量原因）: ${errorLine || result.state}`);
    reportAttention(state, `failed-${stack.ocid}`, [
        `Oracle 免费实例：${stack.label} Apply 失败，不是容量问题，需要看一下`,
        errorLine || `Job 状态：${result.state}`,
        `Job：${result.url}`,
    ]);
}

async function applyStack(state, stack, page) {
    const stackUrl = `https://cloud.oracle.com/resourcemanager/stacks/${stack.ocid}?region=${stack.region}`;
    await page.goto(stackUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    if (isLoginPage(page)) return 'login';

    // 控制台会先渲染旧版页面再切到新版，等新版出现后再稳一下才点。
    let found = await waitForConsoleFrame(page, /General information/, 90000);
    if (found) {
        await sleep(5000);
        found = await waitForConsoleFrame(page, /General information/, 30000);
    }
    if (!found) {
        if (isLoginPage(page)) return 'login';
        throw new Error('Stack 页面 90 秒内没有加载出来');
    }
    const { frame } = found;

    const actionsOpened = await frame.evaluate(() => {
        const button = [...document.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === 'Actions' || node.innerText.trim() === 'Actions');
        if (!button) return false;
        button.click();
        return true;
    });
    if (!actionsOpened) throw new Error('找不到 Stack 的 Actions 按钮');
    await sleep(1500);
    if (!await clickByText(frame, '[role=menuitem]', 'Apply')) throw new Error('Actions 菜单里找不到 Apply');
    await sleep(3000);
    if (!await clickByText(frame, 'dialog button', 'Apply')) throw new Error('Apply 对话框里找不到 Apply 按钮');
    console.log(`[${stack.label}] 已提交 Apply`);

    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && !/\/resourcemanager\/jobs\//.test(page.url())) await sleep(2000);
    if (!/\/resourcemanager\/jobs\//.test(page.url())) throw new Error('提交 Apply 后没有跳转到 job 页面');

    stack.lastAttemptAt = new Date().toISOString();
    stack.attempts = (stack.attempts || 0) + 1;
    return waitForJob(page, null);
}

async function main() {
    forceNoProxyEnv();
    const state = loadState();
    const pending = state.stacks.filter(stack => !stack.done && !stack.disabled);
    if (!pending.length) {
        console.log('跳过：所有 Stack 都已完成');
        saveState(state);
        return;
    }

    await ensureChrome('https://cloud.oracle.com/');
    const { page, close } = await openOwnTab();
    try {
        for (const stack of pending) {
            try {
                let result;
                if (stack.lastJobUrl) {
                    console.log(`[${stack.label}] 先查看上次未结束的 job`);
                    result = await waitForJob(page, stack.lastJobUrl);
                    if (isLoginPage(page)) result = 'login';
                } else {
                    result = await applyStack(state, stack, page);
                }
                if (result === 'login') {
                    console.log('Oracle Cloud 未登录');
                    reportAttention(state, 'login', [
                        'Oracle 免费实例：Oracle Cloud 登录已失效',
                        '请在自动化用的 Chrome 里重新登录 cloud.oracle.com，之后会自动继续重试。',
                    ]);
                    break;
                }
                await handleJobResult(state, stack, page, result);
            } catch (error) {
                console.log(`[${stack.label}] 出错: ${error.message}`);
                reportAttention(state, `error-${stack.ocid}`, [
                    `Oracle 免费实例：${stack.label} 自动 Apply 出错`,
                    error.message.slice(0, 200),
                ]);
            } finally {
                saveState(state);
            }
        }
    } finally {
        await close();
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
