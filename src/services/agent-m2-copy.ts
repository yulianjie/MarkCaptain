import type { AgentDocumentCheckIssue } from './agent'

const copy = {
  en: {
    projectTitle: 'Project context', projectSearchTitle: 'Search this project', projectSearchDetail: 'Read-only project search is separately authorized for this conversation. The model receives text only after it reads a result.',
    noProject: 'Open a project folder to grant project search. A single open document remains available without a project grant.',
    projectRoot: 'Open project', include: 'Included Markdown paths', exclude: 'Excluded paths', includeHint: 'One project-relative glob per line', excludeHint: 'One project-relative glob per line',
    grant: 'Allow project search', updateGrant: 'Update scope and allow', revoke: 'Revoke access', grantBusy: 'Updating project access…', grantActive: 'Read-only project access is active for this conversation.', grantInactive: 'Project configuration never grants access by itself.',
    dirtyBuffers: 'Open unsaved project documents will be frozen into this request; only the search service can read them.',
    projectConfigTitle: 'Project writing rules', writingRulesToggle: 'Apply project writing rules to this request', configLoading: 'Loading project rules…', configLoadFailed: 'Project rules could not be loaded.',
    configSave: 'Save project rules', configSaving: 'Saving…', configSaved: 'Project rules saved.', configConflict: 'Project rules changed elsewhere. Reload before saving.', configReload: 'Reload project rules', configUnavailable: 'Open a project folder to edit project rules.',
    language: 'Writing language', audience: 'Audience', tone: 'Tone', glossary: 'Preferred terminology', preferred: 'Preferred term', avoid: 'Avoid these forms (one per line)', addTerm: 'Add term', removeTerm: 'Remove term',
    enabledByDefault: 'Suggest project search as a starting option', enabledByDefaultHint: 'This preference never grants file access.',
    checkTitle: 'Local document check', checkRun: 'Check document', checkRunning: 'Checking…', checkComplete: 'Complete', checkPartial: 'Partial results', checkFailed: 'The document check failed.', checkNoIssues: 'No deterministic issues found.', checkScope: 'Checks headings, local links and images, and project terminology. External URLs are not verified.',
    checkedExternal: '{count} external links were not verified.', checkedLocal: 'Checked {count} local targets.', issueCount: '{count} findings', severityError: 'Error', severityWarning: 'Warning', severityInfo: 'Info', evidence: 'Evidence', replacement: 'Suggested wording', locateIssue: 'Locate in document', draftRepair: 'Draft a repair for review', modelCheck: 'Ask Agent for a read-only check', modelCheckDetail: 'Returns concerns with evidence. It cannot edit the document.',
    modelCheckPrompt: 'Review the currently attached document for contradictions, redundancy, structure, and insufficient explanation. Return concise concerns with supporting source passages. Do not propose edits, and do not claim anything was externally verified.',
    modelCheckPromptZh: '请只读检查当前附加文档中的矛盾、冗余、结构和解释不足，并引用支持每项疑点的原文。不要提出修改，也不要声称已经进行外部核验。',
    modelCheckPromptJa: '添付文書を読み取り専用で確認し、矛盾・冗長さ・構成・説明不足の疑点を根拠となる原文とともに示してください。修正案は出さず、外部確認済みとも述べないでください。',
    repairPrompt: 'The local document check found this issue: {message}\nEvidence: {evidence}\nSuggested wording: {replacement}\nPlease propose a precise change to the attached document for my review. Do not apply it.',
    repairPromptZh: '本地文档检查发现：{message}\n依据：{evidence}\n建议表述：{replacement}\n请针对附加文档提出精确修改建议供我审阅，不要直接应用。',
    repairPromptJa: 'ローカル文書チェックの指摘：{message}\n根拠：{evidence}\n推奨表現：{replacement}\n添付文書への正確な修正案を提示し、私の確認を待ってください。直接適用しないでください。',
    webTitle: 'Web research', webEnable: 'Use web research for this request', webOff: 'Web research is off by default and stays off until enabled here.', webTopic: 'Research topic', webTopicPlaceholder: 'Describe the question to research',
    allowDocumentQueries: 'Allow query suggestions based on the current document', querySuggestion: 'Suggest queries from document', approvedQueries: 'Approved search queries', approvedQueriesHint: 'Review and edit these queries. Only these exact queries may be sent to search.', queryPlaceholder: 'One approved query per line',
    directUrls: 'Direct URLs supplied by you', directUrlsHint: 'Only HTTP(S) URLs without credentials. Each URL is checked before it is opened.', urlPlaceholder: 'https://example.com/article', urlInvalid: 'Enter valid public HTTP(S) URLs without embedded credentials.',
    webSource: 'Web source', webSnippet: 'Search result; full page not read', webRead: 'Page read', webFailed: 'Page could not be read', webFetched: 'Fetched {date}', webPublished: 'Published {date}', webHttpWarning: 'This source used HTTP without transport encryption.', openWebSource: 'Open source in browser',
    projectSource: 'Project source read', projectSourceOpen: 'Open project source', noProjectSources: 'No project source has been read yet.',
    retrievedResults: 'Retrieved candidates (not read)', noRetrievedResults: 'No project search results have been retrieved.', actualReads: 'Content actually read', noActualReads: 'No source content has been read yet.',
    projectCandidates: 'Project search candidates', candidateLine: 'Line {line}', projectSearchIncomplete: 'Search results may be incomplete.',
    searchProjectTool: 'Search project', readProjectTool: 'Read project passage', searchWebTool: 'Search the web', readWebSourceTool: 'Read web source',
    modelCheckReadOnly: 'Read-only check',
    querySuggestionReview: 'Review and edit these local suggestions, then approve only the queries you want sent.', approveQuery: 'Approve query', webQueryRejected: 'This query looks like a local path, secret, or direct URL. Remove that material and enter a public search phrase.',
    projectConfigConflict: 'Project rules changed elsewhere. Reload the rules before saving again.', webQueryNotApproved: 'The search phrase was not approved. Add it to the approved query list before retrying.', webResearchDisabled: 'Web research is off for this request. Enable it explicitly before retrying.', webUnavailable: 'The web source is currently unavailable.',
    projectConfigVersion: 'This project rules file uses an unsupported schema version. It was left unchanged; do not overwrite it with defaults.', projectConfigInvalid: 'Project rules are invalid or unreadable. Reload them before editing or saving.', projectConfigTooLarge: 'The project rules file exceeds its size limit and was left unchanged.', projectConfigContainsCredentials: 'Project rules cannot store credentials, headers, or commands. Remove those fields and reload.', projectGrantNeedsRenewal: 'Project access changed or expired. Review the scope and grant access again.', projectNotOwned: 'This project is no longer an open workspace. Reopen it before granting access.', projectBufferLimit: 'Unsaved project buffers exceed the transport limit. Save or close some files before searching.', projectBufferScope: 'An unsaved project buffer is outside the authorized scope. Update the scope or close that file.', projectSearchUnavailable: 'Project search could not finish. Reauthorize the project and try again.', webPublicDnsUnavailable: 'Cloudflare public DNS or the secured public connection did not complete. Check connectivity and try again; public-address checks remain active.',
    publicDns: 'Use Cloudflare public DNS for this request', publicDnsDisclosure: 'Cloudflare receives only target domain names for DNS resolution, not URL paths or query strings. Public peer validation remains enabled; no system proxy or DNS setting is changed.', webPrivacyDisclosure: 'Only the exact queries you approve are sent to Bing. Document text is not sent as a query automatically; the model receives search snippets or document passages only when tools return them.',
    projectBuffersTooLarge: 'The open unsaved Markdown buffers exceed the project search limit. Save or close some files, then try again.', projectBufferConflict: 'Two open buffers for the same project file differ. Resolve the duplicate tabs before searching.', projectReferenceLimit: 'This task reached the limit for read project sources. Continue with the sources already read.', projectPatternInvalid: 'Review the project include and exclude patterns. A pattern is invalid or exceeds the limit.', projectUnavailable: 'Open a project folder before granting project search.', projectScopeEmpty: 'Add at least one included path before granting project search.', projectScopeChanged: 'The search scope changed after access was granted. Update the grant before sending.', webResearchEmpty: 'Approve at least one search query or add a direct URL. A topic alone does not authorize a network search.', webResearchLimit: 'Web research allows at most 8 approved queries and 8 URLs; each query can be up to 320 UTF-8 bytes.', checkStale: 'The document changed after the local check. Run the check again before requesting a repair.', checkInvalid: 'The local check returned invalid ranges and could not be displayed.',
  },
  'zh-CN': {
    projectTitle: '项目资料', projectSearchTitle: '搜索当前项目', projectSearchDetail: '本对话单独授权只读项目搜索。模型只有在读取搜索结果后才会收到正文。',
    noProject: '打开项目文件夹后才能授权项目搜索。单独打开的文档仍可正常使用。',
    projectRoot: '当前项目', include: '包含的 Markdown 路径', exclude: '排除的路径', includeHint: '每行一个项目相对 glob', excludeHint: '每行一个项目相对 glob',
    grant: '允许搜索项目', updateGrant: '更新范围并授权', revoke: '撤销访问', grantBusy: '正在更新项目访问权限…', grantActive: '此对话已获得只读项目访问权限。', grantInactive: '项目配置不会自动授予文件访问权限。',
    dirtyBuffers: '本次请求会冻结已打开且未保存的项目文档；只有搜索服务可以读取它们。',
    projectConfigTitle: '项目写作规范', writingRulesToggle: '本次请求应用项目写作规范', configLoading: '正在读取项目规范…', configLoadFailed: '无法读取项目规范。',
    configSave: '保存项目规范', configSaving: '正在保存…', configSaved: '项目规范已保存。', configConflict: '项目规范已在其他位置修改，请重新加载后再保存。', configReload: '重新加载项目规范', configUnavailable: '打开项目文件夹后才能编辑项目规范。',
    language: '写作语言', audience: '目标读者', tone: '语气风格', glossary: '术语规范', preferred: '推荐术语', avoid: '避免写法（每行一个）', addTerm: '添加术语', removeTerm: '删除术语',
    enabledByDefault: '默认建议启用项目搜索', enabledByDefaultHint: '此偏好不会自动授予文件访问权限。',
    checkTitle: '本地文档检查', checkRun: '检查文档', checkRunning: '正在检查…', checkComplete: '检查完成', checkPartial: '结果不完整', checkFailed: '文档检查失败。', checkNoIssues: '没有发现确定性问题。', checkScope: '检查标题层级、本地链接和图片、项目术语；不验证外部网址。',
    checkedExternal: '有 {count} 个外部链接未核验。', checkedLocal: '已检查 {count} 个本地目标。', issueCount: '{count} 项发现', severityError: '错误', severityWarning: '提醒', severityInfo: '信息', evidence: '原文依据', replacement: '建议表述', locateIssue: '定位正文', draftRepair: '生成待审修订草稿', modelCheck: '请 Agent 只读检查', modelCheckDetail: '返回带原文依据的疑点，不会修改文档。',
    modelCheckPrompt: '请只读检查当前附加文档中的矛盾、冗余、结构和解释不足，并引用支持每项疑点的原文。不要提出修改，也不要声称已经进行外部核验。',
    modelCheckPromptZh: '请只读检查当前附加文档中的矛盾、冗余、结构和解释不足，并引用支持每项疑点的原文。不要提出修改，也不要声称已经进行外部核验。',
    modelCheckPromptJa: '添付文書を読み取り専用で確認し、矛盾・冗長さ・構成・説明不足の疑点を根拠となる原文とともに示してください。修正案は出さず、外部確認済みとも述べないでください。',
    repairPrompt: '本地文档检查发现：{message}\n依据：{evidence}\n建议表述：{replacement}\n请针对附加文档提出精确修改建议供我审阅，不要直接应用。',
    repairPromptZh: '本地文档检查发现：{message}\n依据：{evidence}\n建议表述：{replacement}\n请针对附加文档提出精确修改建议供我审阅，不要直接应用。',
    repairPromptJa: 'ローカル文書チェックの指摘：{message}\n根拠：{evidence}\n推奨表現：{replacement}\n添付文書への正確な修正案を提示し、私の確認を待ってください。直接適用しないでください。',
    webTitle: '联网研究', webEnable: '本次请求结合联网研究', webOff: '联网默认关闭；只有在此处启用后才会使用。', webTopic: '研究主题', webTopicPlaceholder: '描述想要研究的问题',
    allowDocumentQueries: '允许根据当前文档形成查询建议', querySuggestion: '从文档建议查询', approvedQueries: '已批准的搜索词', approvedQueriesHint: '请先检查和编辑；只有这些精确查询会发送到搜索服务。', queryPlaceholder: '每行一个已批准的查询',
    directUrls: '你直接提供的网址', directUrlsHint: '仅支持不含认证信息的 HTTP(S) 网址；打开前会校验。', urlPlaceholder: 'https://example.com/article', urlInvalid: '请输入有效的公开 HTTP(S) 网址，不能包含认证信息。',
    webSource: '网页来源', webSnippet: '搜索结果；尚未读取全文', webRead: '已读取页面', webFailed: '无法读取页面', webFetched: '获取于 {date}', webPublished: '发布于 {date}', webHttpWarning: '此来源使用 HTTP，传输未加密。', openWebSource: '在浏览器中打开来源',
    projectSource: '已读取的项目资料', projectSourceOpen: '打开项目来源文档', noProjectSources: '尚未读取项目资料。',
    retrievedResults: '检索候选（尚未读取）', noRetrievedResults: '尚未检索到项目候选。', actualReads: '实际读取的正文', noActualReads: '尚未读取任何来源正文。',
    projectCandidates: '项目搜索候选', candidateLine: '第 {line} 行', projectSearchIncomplete: '搜索结果可能不完整。',
    searchProjectTool: '搜索项目', readProjectTool: '读取项目片段', searchWebTool: '搜索网页', readWebSourceTool: '读取网页来源',
    modelCheckReadOnly: '只读检查',
    querySuggestionReview: '请先检查和编辑这些本地建议，再单独批准希望发送的查询词。', approveQuery: '批准此查询', webQueryRejected: '此查询看起来包含本地路径、密钥或直接网址。请移除这些内容并输入公开搜索短语。',
    projectConfigConflict: '项目规范已在其他位置修改，请重新加载后再保存。', webQueryNotApproved: '该查询词尚未获批准。请先添加到已批准查询列表，再重试。', webResearchDisabled: '本次请求未启用联网研究。请明确启用后再重试。', webUnavailable: '当前无法读取该网页来源。',
    projectConfigVersion: '项目规范文件使用了不支持的版本，文件未被更改；请勿用默认值覆盖。', projectConfigInvalid: '项目规范无效或无法读取，请重新加载后再编辑或保存。', projectConfigTooLarge: '项目规范文件超过大小限制，文件未被更改。', projectConfigContainsCredentials: '项目规范不能保存凭据、请求头或命令；请移除这些字段后重新加载。', projectGrantNeedsRenewal: '项目访问权限已变化或过期，请检查范围并重新授权。', projectNotOwned: '该项目已不再是打开的工作区，请重新打开后再授权。', projectBufferLimit: '未保存的项目缓冲区超出传输限制，请保存或关闭部分文件后再搜索。', projectBufferScope: '有未保存的项目缓冲区不在授权范围内，请调整范围或关闭该文件。', projectSearchUnavailable: '项目搜索未能完成，请重新授权项目后重试。', webPublicDnsUnavailable: 'Cloudflare 公共 DNS 或安全公网连接未能完成。请检查网络后重试；公网地址校验仍会执行。',
    publicDns: '本次请求使用 Cloudflare 公共 DNS', publicDnsDisclosure: 'Cloudflare 只会收到用于 DNS 解析的目标域名，不会收到网址路径或查询参数。仍会验证对端必须是公网地址；此选项不使用系统代理，也不会修改系统 DNS 设置。', webPrivacyDisclosure: '只有你明确批准的查询词会发送给 Bing。正文不会自动变成查询词；模型只会在工具返回时收到搜索摘要或按需读取的文档片段。',
    projectBuffersTooLarge: '已打开的未保存 Markdown 超出项目搜索大小限制。请先保存或关闭部分文件，再试一次。', projectBufferConflict: '同一项目文件有两个内容不同的打开缓冲区。请先处理重复标签，再搜索。', projectReferenceLimit: '本任务已达到已读取项目资料的数量或大小上限，请继续使用现有来源。', projectPatternInvalid: '请检查项目包含和排除规则；某条规则无效或超出限制。', projectUnavailable: '请先打开项目文件夹，再授权项目搜索。', projectScopeEmpty: '请至少添加一条包含路径，再授权项目搜索。', projectScopeChanged: '授权后搜索范围发生了变化，请先更新项目授权再发送。', webResearchEmpty: '请至少批准一个查询词或添加直接网址。研究主题本身不会授权联网搜索。', webResearchLimit: '联网研究最多接受 8 条批准查询词和 8 个网址；每条查询词最多 320 个 UTF-8 字节。', checkStale: '本地检查后文档已变化，请重新检查后再请求修订。', checkInvalid: '本地检查返回了无效范围，无法显示结果。',
  },
  ja: {
    projectTitle: 'プロジェクト資料', projectSearchTitle: 'このプロジェクトを検索', projectSearchDetail: 'この会話に読み取り専用のプロジェクト検索を個別に許可します。本文は検索サービスが読み取るまでモデルに送信されません。',
    noProject: 'プロジェクトフォルダーを開くと検索を許可できます。単独で開いた文書はそのまま利用できます。',
    projectRoot: '現在のプロジェクト', include: '対象 Markdown パス', exclude: '除外パス', includeHint: 'プロジェクト相対 glob を1行に1つ', excludeHint: 'プロジェクト相対 glob を1行に1つ',
    grant: 'プロジェクト検索を許可', updateGrant: '範囲を更新して許可', revoke: 'アクセスを取り消す', grantBusy: 'プロジェクト権限を更新中…', grantActive: 'この会話では読み取り専用のプロジェクトアクセスが有効です。', grantInactive: 'プロジェクト設定だけではファイルアクセスは許可されません。',
    dirtyBuffers: '開いている未保存文書はこのリクエスト用に固定され、検索サービスのみが読み取れます。',
    projectConfigTitle: 'プロジェクトの執筆ルール', writingRulesToggle: 'このリクエストにプロジェクトルールを適用', configLoading: 'プロジェクトルールを読み込み中…', configLoadFailed: 'プロジェクトルールを読み込めませんでした。',
    configSave: 'プロジェクトルールを保存', configSaving: '保存中…', configSaved: 'プロジェクトルールを保存しました。', configConflict: 'プロジェクトルールが他で変更されました。再読み込みしてから保存してください。', configReload: 'プロジェクトルールを再読み込み', configUnavailable: 'プロジェクトルールを編集するにはフォルダーを開いてください。',
    language: '執筆言語', audience: '読者', tone: '文体', glossary: '用語集', preferred: '推奨用語', avoid: '避ける表記（1行に1つ）', addTerm: '用語を追加', removeTerm: '用語を削除',
    enabledByDefault: 'プロジェクト検索を初期候補にする', enabledByDefaultHint: 'この設定はファイルアクセスを許可しません。',
    checkTitle: 'ローカル文書チェック', checkRun: '文書をチェック', checkRunning: 'チェック中…', checkComplete: '完了', checkPartial: '一部の結果', checkFailed: '文書チェックに失敗しました。', checkNoIssues: '決定的な問題は見つかりませんでした。', checkScope: '見出し階層、ローカルリンクと画像、プロジェクト用語を確認します。外部 URL は検証しません。',
    checkedExternal: '外部リンク {count} 件は未検証です。', checkedLocal: 'ローカル参照 {count} 件を確認しました。', issueCount: '{count} 件', severityError: 'エラー', severityWarning: '警告', severityInfo: '情報', evidence: '根拠', replacement: '推奨表現', locateIssue: '文書内の位置へ移動', draftRepair: '修正案をレビュー用に作成', modelCheck: 'Agent に読み取り専用チェックを依頼', modelCheckDetail: '根拠付きの懸念を返し、文書は変更しません。',
    modelCheckPrompt: '添付文書を読み取り専用で確認し、矛盾・冗長さ・構成・説明不足の疑点を根拠となる原文とともに示してください。修正案は出さず、外部確認済みとも述べないでください。',
    modelCheckPromptZh: '请只读检查当前附加文档中的矛盾、冗余、结构和解释不足，并引用支持每项疑点的原文。不要提出修改，也不要声称已经进行外部核验。',
    modelCheckPromptJa: '添付文書を読み取り専用で確認し、矛盾・冗長さ・構成・説明不足の疑点を根拠となる原文とともに示してください。修正案は出さず、外部確認済みとも述べないでください。',
    repairPrompt: 'ローカル文書チェックの指摘：{message}\n根拠：{evidence}\n推奨表現：{replacement}\n添付文書への正確な修正案を提示し、私の確認を待ってください。直接適用しないでください。',
    repairPromptZh: '本地文档检查发现：{message}\n依据：{evidence}\n建议表述：{replacement}\n请针对附加文档提出精确修改建议供我审阅，不要直接应用。',
    repairPromptJa: 'ローカル文書チェックの指摘：{message}\n根拠：{evidence}\n推奨表現：{replacement}\n添付文書への正確な修正案を提示し、私の確認を待ってください。直接適用しないでください。',
    webTitle: 'Web 調査', webEnable: 'このリクエストで Web 調査を使う', webOff: 'Web 調査は初期状態で無効です。ここで有効にした場合のみ使用します。', webTopic: '調査テーマ', webTopicPlaceholder: '調べたい質問を入力',
    allowDocumentQueries: '現在の文書に基づく検索語の提案を許可', querySuggestion: '文書から検索語を提案', approvedQueries: '承認済み検索語', approvedQueriesHint: '確認・編集してください。この完全一致の検索語のみが検索サービスに送信されます。', queryPlaceholder: '1行に1つ承認済み検索語を入力',
    directUrls: 'ユーザーが入力した URL', directUrlsHint: '認証情報を含まない HTTP(S) URL のみ。開く前に検証します。', urlPlaceholder: 'https://example.com/article', urlInvalid: '認証情報を含まない有効な公開 HTTP(S) URL を入力してください。',
    webSource: 'Web ソース', webSnippet: '検索結果。ページ本文は未読です', webRead: 'ページを読み取り済み', webFailed: 'ページを読み取れませんでした', webFetched: '取得日時: {date}', webPublished: '公開日: {date}', webHttpWarning: 'このソースは暗号化されていない HTTP で取得されました。', openWebSource: 'ブラウザーでソースを開く',
    projectSource: '読み取ったプロジェクト資料', projectSourceOpen: 'プロジェクト文書を開く', noProjectSources: 'プロジェクト資料はまだ読み取られていません。',
    retrievedResults: '取得した候補（未読）', noRetrievedResults: 'プロジェクト検索結果はまだありません。', actualReads: '実際に読み取った本文', noActualReads: 'ソース本文はまだ読み取られていません。',
    projectCandidates: 'プロジェクト検索候補', candidateLine: '{line} 行', projectSearchIncomplete: '検索結果が不完全な可能性があります。',
    searchProjectTool: 'プロジェクトを検索', readProjectTool: 'プロジェクトの一部を読む', searchWebTool: 'Web を検索', readWebSourceTool: 'Web ソースを読む',
    modelCheckReadOnly: '読み取り専用チェック',
    querySuggestionReview: 'ローカル候補を確認・編集してから、送信する検索語だけを個別に承認してください。', approveQuery: '検索語を承認', webQueryRejected: '検索語にローカルパス、秘密情報、直接URLが含まれている可能性があります。公開検索向けの語句に直してください。',
    projectConfigConflict: 'プロジェクトルールが他で変更されました。再読み込みしてから保存してください。', webQueryNotApproved: '検索語が承認されていません。再試行前に承認済みリストへ追加してください。', webResearchDisabled: 'このリクエストでは Web 調査が無効です。有効にしてから再試行してください。', webUnavailable: 'Web ソースを読み取れません。',
    projectConfigVersion: 'プロジェクトルールのスキーマバージョンに対応していません。ファイルは変更していません。既定値で上書きしないでください。', projectConfigInvalid: 'プロジェクトルールが無効か読み取れません。編集・保存前に再読み込みしてください。', projectConfigTooLarge: 'プロジェクトルールのファイルサイズが上限を超えています。ファイルは変更していません。', projectConfigContainsCredentials: 'プロジェクトルールに認証情報、ヘッダー、コマンドは保存できません。削除して再読み込みしてください。', projectGrantNeedsRenewal: 'プロジェクト権限が変更または失効しました。範囲を確認して再許可してください。', projectNotOwned: 'このプロジェクトは開いているワークスペースではありません。開き直してから許可してください。', projectBufferLimit: '未保存のプロジェクトバッファが上限を超えています。ファイルを保存または閉じてから再検索してください。', projectBufferScope: '未保存バッファが許可範囲外です。範囲を更新するかファイルを閉じてください。', projectSearchUnavailable: 'プロジェクト検索を完了できませんでした。再許可してから再試行してください。', webPublicDnsUnavailable: 'Cloudflare パブリック DNS または安全な公開接続を完了できませんでした。ネットワークを確認して再試行してください。公開 IP の検証は維持されます。',
    publicDns: 'このリクエストで Cloudflare のパブリック DNS を使う', publicDnsDisclosure: 'Cloudflare に送信するのは名前解決の対象ドメイン名のみで、URL のパスやクエリは送りません。接続先の公開 IP 検証は維持されます。システムプロキシは使わず、DNS 設定も変更しません。', webPrivacyDisclosure: 'Bing に送るのは明示的に承認した検索語だけです。文書本文を自動で検索語にすることはありません。モデルが受け取るのはツールが返した検索スニペットや、必要に応じて読んだ文書の一部だけです。',
    projectBuffersTooLarge: '開いている未保存 Markdown がプロジェクト検索の上限を超えています。ファイルを保存または閉じてから再試行してください。', projectBufferConflict: '同じプロジェクトファイルに内容の異なるバッファが2つあります。重複タブを解決してから検索してください。', projectReferenceLimit: 'このタスクで読み取れるプロジェクト資料の数または合計サイズの上限に達しました。既存の資料を使って続けてください。', projectPatternInvalid: 'プロジェクトの包含・除外パターンを確認してください。無効または上限超過です。', projectUnavailable: 'プロジェクト検索を許可する前にフォルダーを開いてください。', projectScopeEmpty: 'プロジェクト検索を許可するには、包含パスを1つ以上指定してください。', projectScopeChanged: '許可後に検索範囲が変更されました。送信前にアクセス許可を更新してください。', webResearchEmpty: '検索語を1つ以上承認するか、直接 URL を追加してください。テーマだけではネットワーク検索は許可されません。', webResearchLimit: 'Web 調査は承認済み検索語8件、URL8件までです。検索語は UTF-8 で320バイト以下にしてください。', checkStale: 'ローカルチェック後に文書が変更されました。修正を依頼する前に再チェックしてください。', checkInvalid: 'ローカルチェックが無効な範囲を返したため表示できません。',
  },
} as const

export type AgentM2Key = keyof typeof copy.en

export function agentM2Copy(locale: string, key: AgentM2Key, params?: Record<string, string | number>): string {
  const language = locale in copy ? locale as keyof typeof copy : 'en'
  const template = copy[language][key] ?? copy.en[key]
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))
}

export function agentM2ModelCheckPrompt(locale: string): string {
  if (locale === 'zh-CN') return agentM2Copy(locale, 'modelCheckPromptZh')
  if (locale === 'ja') return agentM2Copy(locale, 'modelCheckPromptJa')
  return agentM2Copy('en', 'modelCheckPrompt')
}

export function agentM2RepairPrompt(locale: string, issue: Pick<AgentDocumentCheckIssue, 'message' | 'evidence' | 'replacement'>): string {
  const key = locale === 'zh-CN' ? 'repairPromptZh' : locale === 'ja' ? 'repairPromptJa' : 'repairPrompt'
  return agentM2Copy(locale, key, { message: issue.message, evidence: issue.evidence, replacement: issue.replacement ?? '' })
}
