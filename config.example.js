// 複製本檔為 config.js 後填入你的 Jira 位址。config.js 不進版控。
// manifest.json 的 host_permissions 也要改成同一個位址，該欄位必須是靜態字面值、讀不到本檔。
globalThis.JIRA_CONFIG = {
    baseUrl: 'http://jira.example.com:8080',
};
