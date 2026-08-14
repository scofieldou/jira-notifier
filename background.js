let JIRA_BASE = null;
try {
    importScripts('config.js');
    JIRA_BASE = globalThis.JIRA_CONFIG?.baseUrl ?? null;
} catch {
    // config.js 不進版控，clone 之後尚未建立就會走到這；交給 sync 回報 config 錯誤
}

const JQL = 'assignee = currentUser() AND resolution = Unresolved ORDER BY project ASC, priority DESC';
const FIELDS = 'summary,status,priority,issuetype,project,updated,duedate';
const POLL_ALARM = 'poll';
const POLL_MINUTES = 2;

const issueUrl = (key) => `${JIRA_BASE}/browse/${key}`;
const filterUrl = () => `${JIRA_BASE}/issues/?jql=${encodeURIComponent(JQL)}`;

async function fetchIssues() {
    if (!JIRA_BASE) return { ok: false, reason: 'config' };

    const url = new URL(`${JIRA_BASE}/rest/api/2/search`);
    url.searchParams.set('jql', JQL);
    url.searchParams.set('fields', FIELDS);
    url.searchParams.set('maxResults', '100');

    let res;
    try {
        res = await fetch(url, { credentials: 'include' });
    } catch (err) {
        return { ok: false, reason: 'network', detail: String(err) };
    }

    // Jira 對未認證的請求回 401；session 過期與從沒登入過都會落在這裡
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth' };
    if (!res.ok) return { ok: false, reason: 'http', detail: `HTTP ${res.status}` };

    let data;
    try {
        data = await res.json();
    } catch {
        // 公司網路的登入導向頁會以 200 回 HTML，解析失敗等同沒撈到
        return { ok: false, reason: 'http', detail: '回應不是 JSON' };
    }
    if (!Array.isArray(data.issues)) return { ok: false, reason: 'http', detail: '回應缺少 issues' };

    const issues = data.issues.map((i) => ({
        key: i.key,
        summary: i.fields.summary ?? '(無標題)',
        status: i.fields.status?.name ?? '',
        type: i.fields.issuetype?.name ?? '',
        projectKey: i.fields.project?.key ?? '?',
        projectName: i.fields.project?.name ?? '',
        priorityName: i.fields.priority?.name ?? '',
        // priority.id 是 1=Highest…5=Lowest，直接當排序權重用；沒設優先度的排最後
        priorityRank: Number(i.fields.priority?.id ?? 99),
        updated: i.fields.updated ?? '',
        duedate: i.fields.duedate ?? null,
    }));

    return { ok: true, issues };
}

const NO_PRIORITY = 99;

async function filterByThreshold(issues) {
    const { notifyThreshold } = await chrome.storage.local.get('notifyThreshold');
    const limit = Number(notifyThreshold ?? NO_PRIORITY);

    // 沒設優先度的單一律通知：欄位沒填不等於不重要，寧可多吵一次也不要被靜音吃掉
    return issues.filter((i) => i.priorityRank <= limit || i.priorityRank === NO_PRIORITY);
}

async function notifyNew(newIssues) {
    if (newIssues.length === 1) {
        const issue = newIssues[0];
        // 通知 id 直接用單號，點擊時才知道要開哪一張。requireInteraction 的通知不會自動消失，
        // 而同 id 重複 create 只會靜默更新既有那則、不會再彈出，所以得先清掉
        await chrome.notifications.clear(issue.key);
        chrome.notifications.create(issue.key, {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: `${issue.key} · ${issue.priorityName || '無優先度'}`,
            message: issue.summary,
            contextMessage: `${issue.projectKey} · ${issue.type}`,
            requireInteraction: true,
            priority: 2,
        });
        return;
    }

    await chrome.notifications.clear('batch');
    chrome.notifications.create('batch', {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: `新增 ${newIssues.length} 張指派給你的單`,
        message: newIssues.map((i) => `${i.key} ${i.summary}`).join('\n'),
        requireInteraction: true,
        priority: 2,
    });
}

async function setBadge(state, count) {
    if (state === 'auth') {
        await chrome.action.setBadgeText({ text: '!' });
        await chrome.action.setBadgeBackgroundColor({ color: '#ae2e24' });
        return;
    }
    if (state === 'error') {
        await chrome.action.setBadgeText({ text: '?' });
        await chrome.action.setBadgeBackgroundColor({ color: '#a54800' });
        return;
    }
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#0c66e4' });
}

// 保留最近幾次輪詢的軌跡，用來確認 Chrome 關窗期間鬧鐘是否仍在喚醒 service worker
async function recordPoll(at, source, outcome) {
    const { pollLog } = await chrome.storage.local.get('pollLog');
    const log = Array.isArray(pollLog) ? pollLog : [];
    log.push(`${new Date(at).toLocaleTimeString('zh-TW')} [${source}] ${outcome}`);
    await chrome.storage.local.set({ pollLog: log.slice(-30) });
}

// source 只影響紀錄，用來分辨這次同步是鬧鐘自動觸發還是使用者手動按的
async function sync(source = 'manual') {
    const result = await fetchIssues();
    const at = new Date().toISOString();

    if (!result.ok) {
        await setBadge(result.reason === 'auth' ? 'auth' : 'error');
        // 撈失敗時不動 seenKeys，否則恢復連線後會把整份清單當成新單全部通知一次
        await chrome.storage.local.set({ lastSync: { at, ok: false, ...result } });
        await recordPoll(at, source, `✗ ${result.reason}`);
        return result;
    }

    const { seenKeys } = await chrome.storage.local.get('seenKeys');
    const currentKeys = result.issues.map((i) => i.key);

    // 首次執行只建立基準，不然一裝上去就會被既有的單洗版
    if (Array.isArray(seenKeys)) {
        const known = new Set(seenKeys);
        const fresh = result.issues.filter((i) => !known.has(i.key));
        const worth = await filterByThreshold(fresh);
        if (worth.length > 0) await notifyNew(worth);
    }

    await chrome.storage.local.set({
        issues: result.issues,
        seenKeys: currentKeys,
        lastSync: { at, ok: true, count: currentKeys.length },
    });
    await setBadge('ok', currentKeys.length);
    await recordPoll(at, source, `✓ ${currentKeys.length} 張`);
    return result;
}

// 鬧鐘最快也要等一個週期，所以裝好／開機當下直接同步一次，不讓使用者空等
function start() {
    chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_MINUTES });
    sync('startup');
}

chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === POLL_ALARM) sync('alarm');
});

chrome.notifications.onClicked.addListener((id) => {
    chrome.tabs.create({ url: id === 'batch' ? filterUrl() : issueUrl(id) });
    chrome.notifications.clear(id);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'sync') {
        sync().then(sendResponse);
        return true; // 非同步回覆，必須回 true 讓 channel 保持開啟
    }
});
