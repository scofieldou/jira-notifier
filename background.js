const DEFAULT_JQL =
    'assignee = currentUser() AND resolution = Unresolved ORDER BY project ASC, priority DESC';
const FIELDS = 'summary,status,priority,issuetype,project,updated,duedate';
const POLL_ALARM = 'poll';
const NO_PRIORITY = 99;

// 傳給 storage.get 當預設值，缺鍵時會直接補上，省掉逐項判斷
const DEFAULTS = {
    baseUrl: null,
    pollMinutes: 2,
    notifyThreshold: NO_PRIORITY,
    keepNotification: true,
    jql: DEFAULT_JQL,
};

const issueUrl = (base, key) => `${base}/browse/${key}`;
const filterUrl = (base, jql) => `${base}/issues/?jql=${encodeURIComponent(jql)}`;

const getSettings = () => chrome.storage.local.get(DEFAULTS);

// 位址由使用者在設定頁輸入，權限是動態授予的，隨時可能被使用者在 Chrome 裡撤銷
const hasPermission = (base) => chrome.permissions.contains({ origins: [`${base}/*`] });

async function fetchIssues(settings) {
    if (!settings.baseUrl) return { ok: false, reason: 'config' };
    if (!(await hasPermission(settings.baseUrl))) return { ok: false, reason: 'permission' };

    const url = new URL(`${settings.baseUrl}/rest/api/2/search`);
    url.searchParams.set('jql', settings.jql || DEFAULT_JQL);
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
        priorityRank: Number(i.fields.priority?.id ?? NO_PRIORITY),
        updated: i.fields.updated ?? '',
        duedate: i.fields.duedate ?? null,
    }));

    return { ok: true, issues };
}

function filterByThreshold(issues, limit) {
    // 沒設優先度的單一律通知：欄位沒填不等於不重要，寧可多吵一次也不要被靜音吃掉
    return issues.filter((i) => i.priorityRank <= limit || i.priorityRank === NO_PRIORITY);
}

async function notifyNew(newIssues, settings) {
    const shared = {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        requireInteraction: settings.keepNotification,
        priority: 2,
    };

    if (newIssues.length === 1) {
        const issue = newIssues[0];
        // 通知 id 直接用單號，點擊時才知道要開哪一張。停留型通知不會自動消失，
        // 而同 id 重複 create 只會靜默更新既有那則、不會再彈出，所以得先清掉
        await chrome.notifications.clear(issue.key);
        chrome.notifications.create(issue.key, {
            ...shared,
            title: `${issue.key} · ${issue.priorityName || '無優先度'}`,
            message: issue.summary,
            contextMessage: `${issue.projectKey} · ${issue.type}`,
        });
        return;
    }

    await chrome.notifications.clear('batch');
    chrome.notifications.create('batch', {
        ...shared,
        title: `新增 ${newIssues.length} 張指派給你的單`,
        message: newIssues.map((i) => `${i.key} ${i.summary}`).join('\n'),
    });
}

// 測試通知刻意不套用通知門檻：使用者是明確要求它跳，被自己的設定濾掉只會被誤判成壞了
async function sendTestNotification() {
    const settings = await getSettings();
    await chrome.notifications.clear('test');

    return new Promise((resolve) => {
        chrome.notifications.create(
            'test',
            {
                type: 'basic',
                iconUrl: 'icons/icon128.png',
                title: 'Jira Notifier 測試通知',
                message: '看得到這則通知，就表示通知管道正常。',
                contextMessage: '這不是真的單',
                requireInteraction: settings.keepNotification,
                priority: 2,
            },
            () => resolve({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError?.message })
        );
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
    const settings = await getSettings();
    const result = await fetchIssues(settings);
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
        const worth = filterByThreshold(fresh, Number(settings.notifyThreshold));
        if (worth.length > 0) await notifyNew(worth, settings);
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

function scheduleAlarm(minutes) {
    chrome.alarms.create(POLL_ALARM, { periodInMinutes: Number(minutes) || DEFAULTS.pollMinutes });
}

// 鬧鐘最快也要等一個週期，所以裝好／開機當下直接同步一次，不讓使用者空等
async function start() {
    const { pollMinutes } = await getSettings();
    scheduleAlarm(pollMinutes);
    sync('startup');
}

chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === POLL_ALARM) sync('alarm');
});

// 設定頁只負責寫 storage，鬧鐘重建與立即重抓都由這裡接手
chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (changes.pollMinutes) scheduleAlarm(changes.pollMinutes.newValue);

    // 換了查詢條件等於換了一份清單，沿用舊基準會把新條件多撈到的單全部當成新指派通知一輪
    if (changes.jql) await chrome.storage.local.remove('seenKeys');

    if (changes.baseUrl || changes.jql) sync('settings');
});

chrome.notifications.onClicked.addListener(async (id) => {
    const { baseUrl, jql } = await getSettings();
    if (!baseUrl) return;
    const aggregate = id === 'batch' || id === 'test';
    chrome.tabs.create({ url: aggregate ? filterUrl(baseUrl, jql) : issueUrl(baseUrl, id) });
    chrome.notifications.clear(id);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // 非同步回覆，必須回 true 讓 channel 保持開啟
    if (msg?.type === 'sync') {
        sync().then(sendResponse);
        return true;
    }
    if (msg?.type === 'testNotification') {
        sendTestNotification().then(sendResponse);
        return true;
    }
});
