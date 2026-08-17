const DEFAULT_JQL =
    'assignee = currentUser() AND resolution = Unresolved ORDER BY project ASC, priority DESC';

const DEFAULTS = {
    baseUrl: null,
    pollMinutes: 2,
    notifyThreshold: 99,
    keepNotification: true,
    jql: DEFAULT_JQL,
};

const urlInput = document.getElementById('base-url');
const saveUrlBtn = document.getElementById('save-url');
const urlResult = document.getElementById('url-result');
const pollSelect = document.getElementById('poll-minutes');
const thresholdSelect = document.getElementById('threshold');
const keepCheckbox = document.getElementById('keep-notification');
const testNotifyBtn = document.getElementById('test-notify');
const notifyResult = document.getElementById('notify-result');
const jqlInput = document.getElementById('jql');
const saveJqlBtn = document.getElementById('save-jql');
const resetJqlBtn = document.getElementById('reset-jql');
const jqlResult = document.getElementById('jql-result');

function showIn(el, kind, text) {
    el.className = `result show ${kind}`;
    el.textContent = text;
}

const showResult = (kind, text) => showIn(urlResult, kind, text);

function flash(id) {
    const el = document.getElementById(id);
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 1200);
}

// 只取 origin，順帶吃掉使用者貼進來的路徑與結尾斜線
function normalize(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    try {
        return new URL(withScheme).origin;
    } catch {
        return null;
    }
}

async function testConnection(origin) {
    let res;
    try {
        res = await fetch(`${origin}/rest/api/2/myself`, { credentials: 'include' });
    } catch (err) {
        return { save: false, kind: 'bad', text: `連不上這個位址：${err}` };
    }

    if (res.status === 401 || res.status === 403) {
        // 位址本身是對的，只是這個瀏覽器還沒登入，仍然值得存起來
        return {
            save: true,
            kind: 'warn',
            text: '位址正確，但這個瀏覽器尚未登入 Jira。登入後下次輪詢會自動恢復。',
        };
    }
    if (!res.ok) {
        return { save: false, kind: 'bad', text: `Jira 回應 HTTP ${res.status}，請確認位址是否正確。` };
    }

    try {
        const me = await res.json();
        return { save: true, kind: 'ok', text: `已連線：${me.displayName}（${me.name}）` };
    } catch {
        return { save: false, kind: 'bad', text: '回應不是 JSON，這個位址可能不是 Jira 的 REST 端點。' };
    }
}

async function persistUrl(origin) {
    const { baseUrl: previous } = await chrome.storage.local.get({ baseUrl: null });
    await chrome.storage.local.set({ baseUrl: origin });

    // 換位址時把舊網域的權限收回來，不留著不再使用的存取範圍
    if (previous && previous !== origin) {
        chrome.permissions.remove({ origins: [`${previous}/*`] });
    }
}

saveUrlBtn.addEventListener('click', () => {
    const origin = normalize(urlInput.value);
    if (!origin) {
        showResult('bad', '位址格式不正確。範例：http://jira.mycompany.com:8080');
        return;
    }

    // permissions.request 必須在使用者手勢的同步流程中呼叫，前面不能有 await
    chrome.permissions.request({ origins: [`${origin}/*`] }, async (granted) => {
        if (!granted) {
            showResult('bad', '沒有取得該網域的存取權限，擴充功能無法讀取 Jira。');
            return;
        }

        saveUrlBtn.disabled = true;
        showResult('warn', '測試中…');

        const outcome = await testConnection(origin);
        if (outcome.save) {
            urlInput.value = origin;
            await persistUrl(origin);
        }
        showResult(outcome.kind, outcome.text);
        saveUrlBtn.disabled = false;
    });
});

pollSelect.addEventListener('change', async () => {
    await chrome.storage.local.set({ pollMinutes: Number(pollSelect.value) });
    flash('saved-poll');
});

thresholdSelect.addEventListener('change', async () => {
    await chrome.storage.local.set({ notifyThreshold: Number(thresholdSelect.value) });
    flash('saved-notify');
});

testNotifyBtn.addEventListener('click', async () => {
    testNotifyBtn.disabled = true;
    const outcome = await chrome.runtime.sendMessage({ type: 'testNotification' });

    if (outcome?.ok) {
        showIn(
            notifyResult,
            'ok',
            '已送出。沒看到的話多半是被 Windows 擋下了——先檢查專注輔助是否開啟，並到重要訊息中心翻翻看。'
        );
    } else {
        showIn(notifyResult, 'bad', `送出失敗：${outcome?.error ?? '未知錯誤'}`);
    }

    testNotifyBtn.disabled = false;
});

keepCheckbox.addEventListener('change', async () => {
    await chrome.storage.local.set({ keepNotification: keepCheckbox.checked });
    flash('saved-notify');
});

async function validateJql(baseUrl, jql) {
    // maxResults=0 只要總數不要內容，驗證用不著把單撈回來
    const url = new URL(`${baseUrl}/rest/api/2/search`);
    url.searchParams.set('jql', jql);
    url.searchParams.set('maxResults', '0');

    let res;
    try {
        res = await fetch(url, { credentials: 'include' });
    } catch (err) {
        return { save: false, kind: 'bad', text: `連不上 Jira：${err}` };
    }

    if (res.status === 401 || res.status === 403) {
        return { save: false, kind: 'warn', text: '尚未登入 Jira，無法驗證。請先登入後再試。' };
    }

    let data;
    try {
        data = await res.json();
    } catch {
        return { save: false, kind: 'bad', text: `Jira 回應無法解析（HTTP ${res.status}）。` };
    }

    if (!res.ok) {
        // Jira 對語法錯誤回 400，錯誤描述在 errorMessages 裡，直接原樣轉給使用者最有用
        const detail = data.errorMessages?.join('　') || `HTTP ${res.status}`;
        return { save: false, kind: 'bad', text: detail };
    }

    return { save: true, kind: 'ok', text: `語法正確，目前符合 ${data.total} 張單。` };
}

saveJqlBtn.addEventListener('click', async () => {
    const jql = jqlInput.value.trim();
    if (!jql) {
        showIn(jqlResult, 'bad', '查詢條件不能空白。要回到預設請按「還原預設」。');
        return;
    }

    const { baseUrl } = await chrome.storage.local.get({ baseUrl: null });
    if (!baseUrl) {
        showIn(jqlResult, 'bad', '請先在上面設定 Jira 站台位址。');
        return;
    }

    saveJqlBtn.disabled = true;
    showIn(jqlResult, 'warn', '驗證中…');

    const outcome = await validateJql(baseUrl, jql);
    if (outcome.save) await chrome.storage.local.set({ jql });
    showIn(jqlResult, outcome.kind, outcome.text);
    saveJqlBtn.disabled = false;
});

// 預設值是已知可用的，不必再驗一次；這是填壞之後的退路，要能無條件生效
resetJqlBtn.addEventListener('click', async () => {
    jqlInput.value = DEFAULT_JQL;
    await chrome.storage.local.set({ jql: DEFAULT_JQL });
    showIn(jqlResult, 'ok', '已還原為預設條件。');
});

async function load() {
    const settings = await chrome.storage.local.get(DEFAULTS);
    urlInput.value = settings.baseUrl ?? '';
    pollSelect.value = String(settings.pollMinutes);
    thresholdSelect.value = String(settings.notifyThreshold);
    keepCheckbox.checked = settings.keepNotification;
    jqlInput.value = settings.jql;

    if (!settings.baseUrl) {
        showResult('warn', '尚未設定 Jira 位址，擴充功能目前不會運作。');
        return;
    }

    // 權限可能被使用者在 chrome://extensions 撤銷，位址還在但已經讀不到資料
    const granted = await chrome.permissions.contains({ origins: [`${settings.baseUrl}/*`] });
    if (!granted) {
        showResult('bad', '已失去該網域的存取權限，請再按一次「測試並儲存」重新授權。');
    }
}

load();
