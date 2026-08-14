# 安裝與設定教學

從零開始到收到第一則通知。全程約五分鐘，不需要安裝任何執行環境或套件。

功能總覽與設計說明見 [README.md](README.md)。

## 事前準備

- **Chrome 或 Edge**（以下以 Chrome 為例，Edge 步驟相同，網址把 `chrome://` 換成 `edge://`）
- **一個自架的 Jira Server**，而且你在這個瀏覽器上已經登入
- Git（或直接下載 zip 也行）

沒有其他相依套件，也不需要 Node、Python 或建置流程。

### 先確認你是自架 Jira

瀏覽器打開 Jira，看網址列：

- `https://你的公司.atlassian.net` → 這是 **Jira Cloud，本擴充功能不支援**
- 其他任何位址（常見形式為 `http://jira.公司網域:8080`）→ 自架，可以繼續

### 記下你的 Jira 位址

登入 Jira 後看網址列，取到**連接埠為止**、不含後面的路徑。例如網址是：

```
http://jira.mycompany.com:8080/secure/Dashboard.jspa
```

那你要記下的位址就是：

```
http://jira.mycompany.com:8080
```

⚠️ 結尾**不要留斜線**。後面兩個步驟都會用到這個字串，兩處必須完全一致。

## 步驟 1：取得程式碼

```bash
git clone <這個 repo 的網址> jira-notifier
```

⚠️ **放在一個不會被移動或刪除的位置。** Chrome 是直接讀取這個資料夾，不是把內容複製走——資料夾一旦搬走或刪掉，擴充功能就會失效。

## 步驟 2：建立 config.js

把範例檔複製一份：

```bash
cd jira-notifier
cp config.example.js config.js
```

Windows 的 PowerShell：

```powershell
Copy-Item config.example.js config.js
```

用編輯器打開 `config.js`，把 `baseUrl` 換成你的位址：

```js
globalThis.JIRA_CONFIG = {
    baseUrl: 'http://jira.mycompany.com:8080',
};
```

`config.js` 已經寫進 `.gitignore`，不會被推上去，所以各自的環境位址不會互相污染。

## 步驟 3：修改 manifest.json

打開 `manifest.json`，找到 `host_permissions` 這一行：

```json
"host_permissions": ["http://jira.example.com:8080/*"],
```

換成你的位址，**結尾的 `/*` 要保留**：

```json
"host_permissions": ["http://jira.mycompany.com:8080/*"],
```

**為什麼這裡不能沿用 config.js。** `manifest.json` 是 Chrome 在載入擴充功能前就要解析的宣告檔，那時候還沒有任何程式碼被執行過，因此這個欄位必須是靜態字面值，沒有辦法讀取設定檔。這是 Chrome 的規定，不是本專案的設計。

沒改這裡的話，擴充功能會因為缺少該網域的權限而擋掉所有請求。

### 讓 git 不要一直提示這個修改

`manifest.json` 有進版控，改完之後 `git status` 會一直顯示它被修改。要讓 git 忽略你的本機修改：

```bash
git update-index --skip-worktree manifest.json
```

之後若要改回追蹤（例如要送 PR 修改 manifest 的其他欄位）：

```bash
git update-index --no-skip-worktree manifest.json
```

## 步驟 4：載入到 Chrome

1. 網址列輸入 `chrome://extensions`
2. 開啟右上角的**開發人員模式**
3. 點左上角**載入未封裝項目**
4. 選擇 `jira-notifier` 資料夾（選資料夾本身，不是裡面的檔案）

工具列會出現一個藍底白 `J` 的圖示。看不到的話點工具列的拼圖圖示，把它釘選出來。

## 步驟 5：確認運作

**看徽章。** 圖示右下角應該在幾秒內出現一個藍色數字，那是目前指派給你、尚未結案的單量。數字是 0 時不顯示徽章。

出現其他符號代表有問題：

| 徽章 | 意思 | 處理 |
| --- | --- | --- |
| 藍色數字 | 正常 | — |
| 紅色 `!` | Jira 未登入或 session 過期 | 開啟 Jira 登入即可 |
| 橘色 `?` | 位址設定錯誤或連不上 | 回頭檢查步驟 2、3 兩處位址是否一致 |

**看清單。** 點圖示打開 popup，應該列出你的單，依專案分組。清單顯示「尚未設定 Jira 位址」就是 `config.js` 沒建立或內容有誤。

**測通知。** 通知只在**出現新單號**時才跳，所以剛裝好不會有任何通知（見下一節）。要立刻驗證通知管道是否暢通：

1. `chrome://extensions` → 本擴充功能卡片 → 點 **service worker** 連結
2. 在打開的 Console 貼上：

```js
chrome.storage.local.set({ seenKeys: [] }).then(() => sync('test'));
```

這會清掉已知單號的基準，讓現有的單被當成新單。桌面右下角應該立刻跳出通知，點它會開啟對應的單。

沒跳出來的話見 README 的疑難排解一節，多半是 Windows 的專注輔助擋掉了。

## 首次執行的行為

**裝好之後不會馬上有通知，這是刻意的。**

擴充功能會記住「目前看過哪些單號」作為基準，只有清單裡出現**新的**單號才通知。如果第一次執行就通知，你會被既有的十幾張單一次洗版。

所以安裝當下它只會靜靜建立基準。下一次有人指派新的單給你，才會跳通知。

## 日常使用

裝好之後不需要做任何事。瀏覽器開著它就在背景輪詢，預設每 2 分鐘一次。

- **收到通知**：點通知直接開啟該單
- **看待辦清單**：點工具列圖示，點專案標題可收合該組
- **調整通知門檻**：popup 底部的下拉選單，可設定只有某個優先度以上才通知
- **登入過期**：徽章變紅色 `!` 時，開啟 Jira 重新登入，下次輪詢自動恢復，不需重裝

## 更新版本

```bash
git pull
```

然後到 `chrome://extensions` 點本擴充功能卡片上的**重新整理**（↻）。

`config.js` 不在版控裡，不會被 `git pull` 覆蓋。若前面做過 `skip-worktree`，`manifest.json` 的本機修改也會保留。

改任何程式碼或設定後都要按一次 ↻ 才會生效，這點在開發時特別容易忘。

## 常見安裝問題

**載入時出現 "Manifest file is missing or unreadable"**
選錯資料夾了。要選的是**包含 `manifest.json` 的那一層**，不是它的上層目錄。

**載入時出現 JSON 解析錯誤**
步驟 3 改壞了。常見原因是刪掉了行尾的逗號、或引號變成全形。用編輯器檢查 `manifest.json` 語法。

**徽章顯示橘色 `?`**
位址設定有問題。三個地方要對得起來：`config.js` 的 `baseUrl`、`manifest.json` 的 `host_permissions`、以及瀏覽器實際能開啟的 Jira 網址。常見錯誤是 `baseUrl` 結尾多了斜線、或 `host_permissions` 漏掉結尾的 `/*`。

**徽章顯示紅色 `!` 但我明明登入了**
確認是**同一個瀏覽器設定檔**。在 Edge 登入不會讓 Chrome 的擴充功能拿到 session。另外檢查是否用了無痕視窗登入。

**清單是空的但我確實有被指派的單**
預設的查詢條件是「指派給我**且未結案**」。你的單如果都已經是 Resolved 或 Closed，清單就會是空的，這是正確行為。想改查詢條件見 README 的設定一節。

**Chrome 每次啟動都問要不要停用開發人員模式擴充功能**
這是未上架 Chrome 線上應用程式商店的擴充功能的正常提醒，選擇保留即可。
