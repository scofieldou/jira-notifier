# Jira Notifier

被指派 Jira 單時在桌面右下角跳通知的 Chrome 擴充功能，另附一個依專案分組的待辦清單。

針對**自架 Jira Server** 設計（開發時的對象是 8.6.1）。Atlassian 官方的 Remote MCP Server 與各種 token 方案都只服務 Jira Cloud，自架環境用不上。

## 為什麼是瀏覽器擴充功能

這是整個專案唯一重要的設計決定，其餘都是細節。

Jira Server 8.14 以前**沒有 Personal Access Token**，能用的認證只有帳號密碼或 session cookie。任何跑在瀏覽器外的方案（排程腳本、Electron、Python 常駐程式）都得自己保管憑證——在沒有 PAT 的情況下，那就是使用者的主密碼，而且若 Jira 走的是 HTTP，每次輪詢都會把它明文送上網路。

擴充功能不需要憑證。它跑在使用者已登入的瀏覽器裡，請求自動帶上既有的 session cookie，登入過期時使用者照常登入 Jira 即可恢復。**這個 repo 裡沒有任何密碼、token 或設定檔存放秘密。**

附帶解決的還有兩件事：擴充功能宣告 `host_permissions` 後不受 CORS 限制，也不受 HTTPS 頁面呼叫 HTTP 端點的混合內容封鎖。

## 安裝

完整步驟與疑難排解見 **[SETUP.md](SETUP.md)**。摘要：

1. `git clone` 到一個**不會被移動或刪除**的位置（Chrome 直接讀取這個資料夾）
2. `chrome://extensions` → 開啟**開發人員模式** → **載入未封裝項目** → 選這個資料夾
3. 點擴充功能圖示 → **開啟設定** → 填入 Jira 站台位址 → **測試並儲存**，並同意 Chrome 跳出的授權詢問

**不需要編輯任何檔案。** 位址透過 `optional_host_permissions` 動態授權，因此使用者填什麼網域就授權什麼網域，不必為了改一行 `host_permissions` 去動 `manifest.json`。

前置條件：同一個瀏覽器設定檔要處於 **Jira 已登入**狀態。

未上架 Chrome 線上應用程式商店，所以 Chrome 偶爾會在啟動時詢問是否停用開發人員模式擴充功能，選擇保留即可。

## 使用

**通知** — 指派給你的未結案清單出現新單號時跳出。點擊通知直接開啟該單。通知會停留在畫面上直到你處理它（`requireInteraction`）。

**清單** — 點工具列圖示開啟。依專案分組，組內依優先度由高到低排列。點專案標題可收合該組，收合狀態會保留。點任一列開啟該單。

**徽章** — 圖示上的數字是目前符合查詢條件的單量，底色表示狀態：

| 底色 | 意思 |
| --- | --- |
| 藍色 | 正常 |
| 紫色 | 靜音中 |
| 紅色 `!` | Jira 未登入或 session 過期 |
| 橘色 `?` | 位址錯誤、權限被撤銷或連不上 |

靜音用紫色而非灰色，是因為灰色讀起來像「功能未啟動」，而這裡要表達的是刻意靜音。

**靜音** — popup 標題列的 🔕。靜音後**只擋通知**，輪詢、清單、徽章數字一律照常。沒有時限，只能手動解除——開會多久往往事先不知道，設了時限反而要再設一次。

解除時會把靜音期間累積的通知結算成一份報告：跳一則彙總通知（內文直接列單號），同時在 popup 清單頂端顯示完整列表，看過按 ✕ 消掉。期間被指派、但解除前又轉走的單不會列出，只在末尾記一筆數量——列出來反而讓人困惑。

**通知門檻** — popup 底部可設定只有某個優先度以上才跳通知。門檻只影響通知，清單與徽章仍顯示全部。

## 設定

popup 右上角的齒輪開啟設定頁，全部即時生效，不需要重新載入擴充功能。

| 項目 | 預設 | 說明 |
| --- | --- | --- |
| Jira 站台位址 | 無 | 儲存時會實際連線測試，並要求該網域的存取授權 |
| 檢查間隔 | 2 分鐘 | 也決定了被指派後最久多久收到通知 |
| 通知門檻 | 全部 | 只有某個優先度以上才通知。**只影響通知**，清單與徽章一律顯示全部 |
| 通知停留在畫面上 | 開啟 | 關閉的話通知會在數秒後自動消失並收進系統通知中心 |
| JQL 查詢條件 | 指派給我且未結案 | 決定要追蹤哪些單。儲存前會送到 Jira 驗證語法 |

JQL 填錯的失敗模式是**清單整個空掉**，而那跟「真的沒有單」長得一模一樣，所以儲存前一律先驗證，語法錯誤時直接把 Jira 回傳的 `errorMessages` 原樣顯示。旁邊的**還原預設**不經驗證直接生效，是填壞之後的退路。

改動 JQL 會一併清掉已知單號的基準——換了查詢條件等於換了一份清單，沿用舊基準會把新條件多撈到的單全部當成新指派通知一輪。

## 運作方式

Manifest V3 的 service worker **不常駐**，閒置約 30 秒後會被 Chrome 回收。`chrome.alarms` 負責定期喚醒它：

```
alarm（每 POLL_MINUTES 分鐘）
  └ 喚醒 service worker
      └ fetch /rest/api/2/search（cookie 自動附帶）
          └ 與 storage 中的 seenKeys 比對
              └ 有新單號 → 過濾通知門檻 → chrome.notifications
                  └ 更新 seenKeys、issues、徽章
```

幾個刻意的行為：

- **偵測靠單號集合的差異，不靠時間戳。** 單子可能是幾個月前開的、今天才轉到你身上，`created` 抓不到；而 `updated` 會被任何留言或欄位變更觸發，一天會吵很多次。
- **首次執行只建立基準、不發通知**，否則安裝當下會被既有的單洗版。
- **撈取失敗時不更新 `seenKeys`**，避免斷線恢復後把整份清單當成新單全部通知一次。
- **被門檻擋下的單仍然記入基準**，所以事後放寬門檻不會湧出一堆舊單的通知。
- **沒有設定優先度的單一律通知。** 欄位沒填不代表不重要。
- 通知 id 直接使用單號，且**建立前會先清除同 id 的舊通知**——`requireInteraction` 的通知不會自動消失，而以相同 id 重複建立只會靜默更新既有那則、不會再次彈出。

靜音期間該通知的單會進 `mutedQueue` 而不是被丟棄，`seenKeys` 照常更新。反過來做（靜音時不更新 `seenKeys`，解除時讓它們自然爆出來）看似省事，但期間被指派又轉走的單會被錯報成新指派——它已經不在你手上了。

`storage.local` 中保存的鍵：設定為 `baseUrl`、`pollMinutes`、`notifyThreshold`、`keepNotification`、`jql`、`mutedSince`，狀態為 `issues`、`seenKeys`、`lastSync`、`collapsed`、`pollLog`、`mutedQueue`、`missedReport`。全部都是非敏感資料。

設定頁只負責寫入 `storage`，鬧鐘重建與變更後的立即重抓由 background 的 `storage.onChanged` 接手——這樣設定頁不必知道 service worker 醒著沒有。

## 疑難排解

診斷指令請在 service worker 的 console 執行：`chrome://extensions` → 本擴充功能卡片 → **service worker** 連結。

**徽章顯示 `!`** — Jira session 過期。開啟 Jira 登入，下次輪詢自動恢復，不需重新安裝。

**通知沒跳出來** — 先到設定頁按**送出測試通知**。跳得出來代表通知管道正常，問題在偵測邏輯而非作業系統；跳不出來就是被 Windows 擋了，往下看。

要進一步分辨是「沒建立」還是「建立了但沒顯示」：

```js
chrome.notifications.getAll().then(n => console.log(Object.keys(n)))
```

有列出單號代表擴充功能這端正常，問題在作業系統。檢查 Windows 的**專注輔助**是否開啟，以及「設定 → 系統 → 通知與動作」中 Chrome 是否被停用、「在螢幕上顯示通知橫幅」是否勾選。通知多半躺在重要訊息中心裡。

**懷疑背景沒在跑** — 檢視最近的輪詢紀錄，標籤會標明是鬧鐘自動觸發還是手動：

```js
chrome.storage.local.get('pollLog').then(r => console.log(r.pollLog.join('\n')))
```

正常應該每 `POLL_MINUTES` 分鐘一筆 `[alarm]`。注意**開啟 popup 本身就會觸發一次同步**，觀察期間不要點圖示，否則紀錄會混入 `[manual]`。

若完全沒有 `[alarm]`，確認鬧鐘存在：

```js
chrome.alarms.getAll().then(as => console.log(as))
```

**手動觸發一次通知** — 清空基準後同步，最近的單會被當成新單：

```js
chrome.storage.local.set({ seenKeys: [] }).then(() => sync('test'));
```

## 限制

- **輪詢，不是推播。** 延遲最多一個輪詢週期。即時推送需要 Jira webhook，而擴充功能沒有可被連線的端點，架構上做不到。
- **需要 Chrome 在執行。** 關閉所有視窗後仍要運作的話，開啟 `chrome://settings/system` 的「關閉 Google Chrome 時繼續執行背景應用程式」，並以關閉視窗而非「離開」的方式收起瀏覽器。
- **只認得出現在 JQL 結果中的單。** 指派後在下次輪詢前就被結案的單不會通知。
- 僅在 Jira Server 8.6.1 上驗證過。Jira Cloud 的 REST 回應格式不同（描述欄為 ADF），未支援。

## 檔案

| 檔案 | 內容 |
| --- | --- |
| `manifest.json` | 權限與進入點宣告 |
| `background.js` | service worker：輪詢、差異比對、通知、徽章 |
| `popup.html` / `popup.js` | 待辦清單 UI |
| `options.html` / `options.js` | 設定頁：位址授權、輪詢、通知 |
| `icons/` | 16 / 32 / 48 / 128 四種尺寸 |
| `SETUP.md` | 安裝與設定教學 |

無建置流程、無相依套件。改完直接重新載入擴充功能即可。
