const DEFAULT_JQL =
    'assignee = currentUser() AND resolution = Unresolved ORDER BY project ASC, priority DESC';

const PRIORITY_COLOR = {
    1: '#c9372c',
    2: '#e56910',
    3: '#b38600',
    4: '#0c66e4',
    5: '#8993a4',
};

const list = document.getElementById('list');
const syncState = document.getElementById('sync-state');
const refreshBtn = document.getElementById('refresh');

// popup 每次關閉都會整個銷毀，摺疊狀態得寫進 storage 才留得住
let collapsed = new Set();
// 位址存在設定裡，讀出來前所有連往 Jira 的連結都不成立
let baseUrl = null;
let jql = DEFAULT_JQL;

function openTab(url) {
    chrome.tabs.create({ url });
    window.close();
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function groupByProject(issues) {
    const groups = new Map();
    for (const issue of issues) {
        if (!groups.has(issue.projectKey)) {
            groups.set(issue.projectKey, { name: issue.projectName, issues: [] });
        }
        groups.get(issue.projectKey).issues.push(issue);
    }

    for (const group of groups.values()) {
        group.issues.sort(
            (a, b) => a.priorityRank - b.priorityRank || b.updated.localeCompare(a.updated)
        );
    }

    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function renderIssue(issue) {
    const row = el('div', 'issue');
    row.addEventListener('click', () => openTab(`${baseUrl}/browse/${issue.key}`));

    const dot = el('span', 'dot');
    dot.style.background = PRIORITY_COLOR[issue.priorityRank] ?? '#8993a4';
    dot.title = issue.priorityName || '無優先度';

    const body = el('div', 'issue-body');
    const top = el('div', 'issue-top');
    top.append(el('span', 'key', issue.key), el('span', 'prio', issue.priorityName));
    body.append(top, el('div', 'summary', issue.summary));

    const meta = el('div', 'meta');
    if (issue.status) meta.append(el('span', 'chip', issue.status));
    if (issue.type) meta.append(el('span', 'chip', issue.type));
    if (issue.duedate) meta.append(el('span', 'due', `到期 ${issue.duedate}`));
    if (meta.childElementCount > 0) body.append(meta);

    row.append(dot, body);
    return row;
}

function renderProblem(lastSync) {
    const box = el('div', 'problem');

    const openOptions = (text) => {
        const btn = el('button', null, text);
        btn.addEventListener('click', () => chrome.runtime.openOptionsPage());
        box.append(btn);
        list.replaceChildren(box);
    };

    if (lastSync?.reason === 'config') {
        box.append(el('strong', null, '尚未設定 Jira 位址'));
        box.append(document.createTextNode('到設定頁填入你的 Jira 站台位址後即可開始運作。'));
        openOptions('開啟設定');
        return;
    }

    if (lastSync?.reason === 'permission') {
        box.append(el('strong', null, '缺少存取權限'));
        box.append(document.createTextNode('尚未授權存取這個 Jira 網域，請到設定頁重新儲存位址。'));
        openOptions('開啟設定');
        return;
    }

    if (lastSync?.reason === 'auth') {
        box.append(el('strong', null, '尚未登入 Jira'));
        box.append(document.createTextNode('session 已過期或未登入，登入後會自動恢復。'));
        const btn = el('button', null, '開啟 Jira 登入');
        btn.addEventListener('click', () => openTab(baseUrl));
        box.append(btn);
    } else {
        box.append(el('strong', null, '連不上 Jira'));
        box.append(document.createTextNode(lastSync?.detail || '請確認是否在公司網路環境。'));
    }

    list.replaceChildren(box);
}

function render(issues, lastSync) {
    if (lastSync && !lastSync.ok) {
        renderProblem(lastSync);
        return;
    }

    if (!issues || issues.length === 0) {
        // 查詢條件可自訂，所以這裡不能寫死「沒有指派給你的單」
        list.replaceChildren(el('div', 'empty', '目前沒有符合查詢條件的單 🎉'));
        return;
    }

    const frag = document.createDocumentFragment();
    for (const [key, group] of groupByProject(issues)) frag.append(renderGroup(key, group));
    list.replaceChildren(frag);
}

function renderGroup(key, group) {
    const head = el('div', 'group-head');
    head.append(
        el('span', 'caret', '▾'),
        el('span', 'group-key', key),
        el('span', 'group-name', group.name),
        el('span', 'group-count', `${group.issues.length}`)
    );

    const body = el('div', 'group-body');
    for (const issue of group.issues) body.append(renderIssue(issue));

    const apply = (isCollapsed) => {
        head.classList.toggle('collapsed', isCollapsed);
        body.classList.toggle('collapsed', isCollapsed);
    };
    apply(collapsed.has(key));

    head.addEventListener('click', () => {
        const next = !collapsed.has(key);
        if (next) collapsed.add(key);
        else collapsed.delete(key);
        apply(next);
        chrome.storage.local.set({ collapsed: [...collapsed] });
    });

    const wrap = el('div', 'group');
    wrap.append(head, body);
    return wrap;
}

function renderSyncState(lastSync) {
    if (!lastSync?.at) {
        syncState.textContent = '';
        return;
    }
    const time = new Date(lastSync.at).toLocaleTimeString('zh-TW', {
        hour: '2-digit',
        minute: '2-digit',
    });
    syncState.textContent = lastSync.ok ? `更新於 ${time}` : `失敗於 ${time}`;
}

async function paint() {
    const stored = await chrome.storage.local.get([
        'issues',
        'lastSync',
        'collapsed',
        'baseUrl',
        'jql',
    ]);
    const { issues, lastSync } = stored;
    collapsed = new Set(Array.isArray(stored.collapsed) ? stored.collapsed : []);
    baseUrl = stored.baseUrl ?? null;
    jql = stored.jql || DEFAULT_JQL;
    render(issues, lastSync);
    renderSyncState(lastSync);
}

async function sync() {
    refreshBtn.disabled = true;
    syncState.textContent = '更新中…';
    await chrome.runtime.sendMessage({ type: 'sync' });
    await paint();
    refreshBtn.disabled = false;
}

refreshBtn.addEventListener('click', sync);

document.getElementById('open-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
});

document.getElementById('open-all').addEventListener('click', () => {
    if (baseUrl) openTab(`${baseUrl}/issues/?jql=${encodeURIComponent(jql)}`);
});

// 先畫快取內容再重抓，避免開啟 popup 時空白一拍
paint().then(sync);
