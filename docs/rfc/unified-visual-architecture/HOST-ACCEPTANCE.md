# Real Host Acceptance — 未執行的驗收腳本

Status：**Proposed / NOT RUN**。Current本次只有FakeHostbrowser與MCPclienttests；沒有真實ChatGPTWeb/Mobile session。此表供Phase7填證據，不作相容性已驗證宣告。OpenDecision OD-04；FutureHostsupport須另填platformrecord。

## Required Run Record

每平台分開記錄：dateUTC、candidateSHA/version、serverNode/Python/Sharp、connectorauth模式、Hostname/build、browser/app/OS/device、network、CSP實際header/console錯誤（redacted）、工具schema/resourceURI、測試ID、steps、observed/expected、screenshot/trace、pass/fail/blocked與issue。不得記accesskey、tokens、個人聊天或無關檔案。

| Case | Preconditions / steps | Expected / invariants | Evidence status |
| --- | --- | --- | --- |
| UVA-38 Web | 真ChatGPT連httpscandidate；建image+graphA+graphB並排；兩vp同Graph；pen/resize/lock/undo；LLMreadsameRevision | 只指定doc改、camera隔離、editabledata持續、畫圖留ChatGPT內 | NOT RUN |
| UVA-38 CAS/bundle | 定義→plotlink→手改→autorefresh；選fork；export/import至乾淨candidate；再改ink | conflict保手改、完整metadata/refs、importedCASstale | NOT RUN |
| UVA-38 lifecycle | closeGraphPanel→reopen；reloadconversation/widget；同doc第二widget並改；tools結果重送 | 無duplicatecreation、noeffectreplay、conflict保draft、servercontent恢復 | NOT RUN |
| UVA-39 iOS | 記實際app/OS/device；portraittabs→兩指pinch→pen/touch→keyboard→rotate→background/resume | 不誤畫、不移位、tab/panelbinding正確；savedink可再編輯 | NOT RUN |
| UVA-39 Android | 同上，實際Androidapp/device/S Pen（若有），keyboard/rotation/resume | 同invariants；不能套用iOS結果 | NOT RUN |
| UVA-40 MCPAppsHost | 實際支援MCPApps的Host，initialize/visibility/resize/fullscreen/unknownmethod | negotiatedfallback、app-onlytools不曝model、普通MCP仍可讀data/image | NOT RUN |
| UVA-40 CSP/delivery | 實際CSP與sandbox；大圖片preview/chunks；missing_metafallback（若可合法重現）；toolinput/resultordering | 無外部script依賴，chunks驗hash，不聲稱Host保證ordering | NOT RUN |

重現工具結果重送/丟_meta若真Host無法控制，先記真實觀察範圍，FakeHost的故障注入證據另列，不把未觸發分支寫pass。任何case blocked需註原因與後續最小動作；releasegate不得用人工勾選代替觀察。真Host不可測時可提交candidate供review，但相關client維持Not tested且不得解除該platformgate。

## Phase 0.1 — Additional Live Acceptance Steps

仍為NOT RUN；在UVA-38/39真Host腳本追加：user選AI/module Annotation逐項Move/Resize/Restyle/Relayer/Relabel/Delete/Undo/Redo，讀server的createdBy/lastEditedBy、Evidence applicability與current/historical Verification；geometry改動後必stale，color/presentationlabel不誤使Findingstale，LLM隨後修改受userguard阻擋。legacy工具行為另驗不變；不是以clientauthor字段賦權。

Embed：在parent預設畫一筆，serverref必指parent；explicit「編輯來源」後再畫，ref必指child；childcommit使兩parentviewport更新但parentcontentrev不偽增；childarchive/revokeread顯placeholder無快取內容洩漏。關newfeatureflag只影響入口，不刪已存doc/解除authorityfence。每平台都需觀察，不以FakeHost證明。
