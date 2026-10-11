/**
 * ===================================================================
 * eBay → Instagram/X 投稿サポートツール - GAS バックエンド（下書き v2）
 * ===================================================================
 * 要件定義_Instagram自動投稿.md に準拠。
 *
 * 【重要・セキュリティ】
 * eBay / Claude の実際のAPIキーは、このファイルに書き込まないこと。
 * Apps Scriptエディタの「プロジェクトの設定」→「スクリプト プロパティ」
 * から直接入力する。このコードは PropertiesService 経由でしか
 * キーの値を読まないので、実際の値がこのファイル（＝将来GitHub等に
 * 置かれる可能性のある場所）に残ることは一切ない。
 *
 * 【v2での変更点（2026-08-30）】
 * フェーズ0の検証で分かったこと：
 *   - Trading APIのGetItemの`HitCount`は、eBayがもう返してくれない（廃止済み）。
 *   - View数は、Sell APIs の Analytics API（`traffic_report`）から取得する。
 *     こちらは`sell.analytics.readonly`スコープを持つ「本物のOAuthアクセストークン」
 *     が必要（Refresh Tokenから発行する）。developer.ebay.comの「User Tokens」
 *     ページで手軽に取れるAuth'n'Authの長期User Tokenとは別物なので注意。
 *   - 認証は「eBay投稿サポート」専用に作り直す必要はなく、既存の
 *     ebay-price-checkerで発行済みのRefresh Tokenをそのまま使い回せる
 *     （同じeBay Developerアプリ＝同じApp ID/Cert IDである前提）。
 * ===================================================================
 */

// ---- スクリプトプロパティのキー名（値はプロジェクト設定側で入力） ----
var PROP = {
  EBAY_APP_ID: 'EBAY_APP_ID',
  EBAY_CERT_ID: 'EBAY_CERT_ID',
  EBAY_DEV_ID: 'EBAY_DEV_ID',
  EBAY_REFRESH_TOKEN: 'EBAY_REFRESH_TOKEN', // ebay-price-checkerで発行済みのものを流用可
  CLAUDE_API_KEY: 'CLAUDE_API_KEY',
  SETTINGS: 'SETTINGS_JSON',
  POSTED_IDS_PREFIX: 'POSTED_IDS_', // 年ごとに分割: 例 POSTED_IDS_2026
  SKIPPED_IDS_PREFIX: 'SKIPPED_IDS_', // 「見送る」を押した商品のID。年ごとに分割（2026-09-02追加）
  LAST_ACTIVE_AT: 'LAST_ACTIVE_AT',
  AUTO_STOPPED: 'AUTO_STOPPED',
  STOP_NOTIFIED: 'STOP_NOTIFIED',
  ACCESS_PASSWORD: 'ACCESS_PASSWORD', // 承認アプリのアクセス制御用（要件定義9章）
  TODAY_CANDIDATES_CHUNK_PREFIX: 'TODAY_CANDIDATES_CHUNK_', // 本日の候補（チャンク分割。2026-09-10追加）
  TODAY_CANDIDATES_CHUNK_COUNT: 'TODAY_CANDIDATES_CHUNK_COUNT',
  FRAME_IMAGE_CHUNK_PREFIX: 'FRAME_IMAGE_CHUNK_', // 投稿画像に重ねる枠（チャンク分割。2026-09-24追加）
  FRAME_IMAGE_CHUNK_COUNT: 'FRAME_IMAGE_CHUNK_COUNT',
  RUN_STATUS: 'RUN_STATUS_JSON', // 候補作成（dailyRun）の実行状況。🔄の完了確認に使う（2026-10-11追加）
};

// 承認アプリ本体（GitHub Pages）のURL。メール通知のリンク先はここにする
// （ScriptApp.getService().getUrl()はGAS Web AppのAPIエンドポイント自体のURLで、
// 人間が開く画面ではないため、これまでメールのリンクを開いても画面が表示されなかった。2026-09-02修正）。
var APPROVAL_APP_URL = 'https://sasken-123.github.io/ebay-ig-app/';

// 【2026-10-11追加】自動アップデート用のバージョン番号。
// このCode.gsはGitHub（sasken-123/ebay-ig-app）に置き、GAS側の「ローダー」（GASエディタの
// コード.gs。GAS用ローダー.gs）がGitHubから取り込んで動かす。Claudeが修正するたびにこの値を
// 新しくし、承認アプリ（index.html）のEXPECTED_CODE_VERSIONと必ず同じ値にそろえる。
// アプリを開いた時にこの値が食い違っていると、アプリがローダーに「GitHubの最新Code.gsを
// 取り込んで」と依頼する。
var CODE_VERSION = '2026-10-11.3';

var DEFAULT_SETTINGS = {
  days: 10,
  minViews: 300,
  count: 3,
  igAccount: '',
  xAccount: '',
  inactivityStopDays: 14,
  xCharLimit: 280,   // X投稿文の文字数上限。承認アプリの⚙️設定画面から変更可能（2026-09-02追加）
  igCharLimit: 2200, // Instagram投稿文の文字数上限。同上
  triggerHour: 6,    // dailyRunの自動実行時刻（時。0-23）。承認アプリの⚙️設定画面から変更可能（2026-09-05追加）
};

var EBAY_NS = XmlService.getNamespace('urn:ebay:apis:eBLBaseComponents');

// ===================================================================
// 設定の読み書き（要件定義4章・6章・11章）
// ===================================================================
function getSettings() {
  var raw = PropertiesService.getScriptProperties().getProperty(PROP.SETTINGS);
  if (!raw) return Object.assign({}, DEFAULT_SETTINGS);
  try {
    return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
  } catch (e) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

function saveSettings(newSettings) {
  var before = getSettings();
  var merged = Object.assign({}, before, newSettings);
  PropertiesService.getScriptProperties().setProperty(PROP.SETTINGS, JSON.stringify(merged));
  // 自動実行時刻が変わった場合だけ、既存のdailyRunトリガーを作り直す（毎回作り直すと
  // 無関係な設定変更のたびにトリガーIDが変わってしまうため、変更時のみに限定。2026-09-05追加）。
  if (merged.triggerHour !== before.triggerHour) {
    applyTriggerHour(merged.triggerHour);
  }
  return merged;
}

// ===================================================================
// dailyRunの時間主導トリガーを、指定した時刻（0-23時）に作り直す。
// atHour(h)はGASの仕様上「h時〜h+1時の間のどこかで1回」実行される（正確に0分ちょうどではない）。
// 承認アプリの⚙️設定画面「自動実行の時刻」から呼ばれる（2026-09-05追加）。
// ===================================================================
function applyTriggerHour(hour) {
  var h = Number(hour);
  if (isNaN(h) || h < 0 || h > 23) {
    Logger.log('applyTriggerHour: 不正な時刻のため変更をスキップしました: ' + hour);
    return;
  }
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyRun') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('dailyRun').timeBased().everyDays(1).atHour(h).create();
  Logger.log('dailyRunのトリガーを' + h + '時台に設定しました');
}

// GASエディタから直接▶実行して、トリガー管理の権限を許可するための引数なしラッパー。
// applyTriggerHour(hour)は引数が必要なため、エディタの関数選択から直接実行すると
// hourがundefinedになってしまう（2026-09-05、実際にこの症状が発生したため追加）。
// これを実行すると、現在保存されている設定のtriggerHour（未設定なら6時）が適用される。
function grantTriggerPermission() {
  applyTriggerHour(getSettings().triggerHour || 6);
}

// ===================================================================
// 投稿済みIDリスト（年ごとにプロパティを分けて9KB制限を回避。要件定義3章）
// ===================================================================
function getPostedIds() {
  var year = new Date().getFullYear();
  var raw = PropertiesService.getScriptProperties().getProperty(PROP.POSTED_IDS_PREFIX + year);
  return raw ? JSON.parse(raw) : [];
}

function addPostedId(itemId) {
  var year = new Date().getFullYear();
  var key = PROP.POSTED_IDS_PREFIX + year;
  var ids = getPostedIds();
  if (ids.indexOf(itemId) === -1) {
    ids.push(itemId);
    PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(ids));
  }
}

function isPosted(itemId) {
  var props = PropertiesService.getScriptProperties();
  var thisYear = new Date().getFullYear();
  for (var y = thisYear; y >= thisYear - 2; y--) {
    var raw = props.getProperty(PROP.POSTED_IDS_PREFIX + y);
    if (raw && JSON.parse(raw).indexOf(itemId) !== -1) return true;
  }
  return false;
}

// ===================================================================
// 見送り済みIDリスト（要件定義5章の運用変更・2026-09-02）
//
// 当初（2026-08-30確定）は「見送る」はその回だけの判断で、条件を満たす限り翌日以降も
// また候補に出す仕様だった。実運用で同じ商品を毎日見返す手間が煩わしいという声を受け、
// 「見送る」も「投稿完了にする」と同様に、一度押したら二度と候補に出さない仕様に変更した。
// 「投稿済み」と「見送り済み」は意味が違う（統計等で将来区別したくなる可能性がある）ため、
// 同じPOSTED_IDSに混ぜず、別プロパティとして持つ。
// ===================================================================
function getSkippedIds() {
  var year = new Date().getFullYear();
  var raw = PropertiesService.getScriptProperties().getProperty(PROP.SKIPPED_IDS_PREFIX + year);
  return raw ? JSON.parse(raw) : [];
}

function addSkippedId(itemId) {
  var year = new Date().getFullYear();
  var key = PROP.SKIPPED_IDS_PREFIX + year;
  var ids = getSkippedIds();
  if (ids.indexOf(itemId) === -1) {
    ids.push(itemId);
    PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(ids));
  }
}

function isSkipped(itemId) {
  var props = PropertiesService.getScriptProperties();
  var thisYear = new Date().getFullYear();
  for (var y = thisYear; y >= thisYear - 2; y--) {
    var raw = props.getProperty(PROP.SKIPPED_IDS_PREFIX + y);
    if (raw && JSON.parse(raw).indexOf(itemId) !== -1) return true;
  }
  return false;
}

// ===================================================================
// 操作なし期間による自動停止（要件定義11章）
// ===================================================================
function recordActivity() {
  var props = PropertiesService.getScriptProperties();
  props.setProperty(PROP.LAST_ACTIVE_AT, String(Date.now()));
  props.setProperty(PROP.AUTO_STOPPED, 'false');
  props.setProperty(PROP.STOP_NOTIFIED, 'false');
}

function isInactiveBeyondThreshold() {
  var props = PropertiesService.getScriptProperties();
  var lastActive = Number(props.getProperty(PROP.LAST_ACTIVE_AT) || Date.now());
  var days = getSettings().inactivityStopDays;
  var elapsedDays = (Date.now() - lastActive) / (1000 * 60 * 60 * 24);
  return elapsedDays > days;
}

// ===================================================================
// eBay OAuth: Refresh Token → アクセストークン（要検証で確定した本実装）
// Trading API（IAF-TOKENヘッダー）・Analytics API（Bearerヘッダー）共通で使う。
// ===================================================================
function getEbayAccessToken() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('EBAY_ACCESS_TOKEN');
  if (cached) return cached;

  var props = PropertiesService.getScriptProperties();
  var appId = props.getProperty(PROP.EBAY_APP_ID);
  var certId = props.getProperty(PROP.EBAY_CERT_ID);
  var refreshToken = props.getProperty(PROP.EBAY_REFRESH_TOKEN);
  if (!appId || !certId || !refreshToken) {
    throw new Error('eBayの認証情報（EBAY_APP_ID / EBAY_CERT_ID / EBAY_REFRESH_TOKEN）がスクリプトプロパティに設定されていません。');
  }

  var basicAuth = Utilities.base64Encode(appId + ':' + certId);
  var options = {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    headers: { Authorization: 'Basic ' + basicAuth },
    payload: {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
    muteHttpExceptions: true,
  };
  var res = UrlFetchApp.fetch('https://api.ebay.com/identity/v1/oauth2/token', options);
  var json = JSON.parse(res.getContentText());
  if (!json.access_token) {
    throw new Error('アクセストークンの取得に失敗しました: ' + res.getContentText());
  }
  // 実際は2時間有効。安全マージンを取って100分でキャッシュを切る
  cache.put('EBAY_ACCESS_TOKEN', json.access_token, 60 * 100);
  return json.access_token;
}

// ===================================================================
// Trading API（GetMyeBaySelling / GetItem）共通呼び出し
// ===================================================================
function _xmlChildText(parent, name) {
  if (!parent) return '';
  var child = parent.getChild(name, EBAY_NS);
  return child ? child.getText() : '';
}

function callTradingApi(callName, xmlBody) {
  var props = PropertiesService.getScriptProperties();
  var appId = props.getProperty(PROP.EBAY_APP_ID);
  var devId = props.getProperty(PROP.EBAY_DEV_ID);
  var certId = props.getProperty(PROP.EBAY_CERT_ID);
  var accessToken = getEbayAccessToken();

  var options = {
    method: 'post',
    contentType: 'text/xml',
    headers: {
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-APP-NAME': appId,
      'X-EBAY-API-DEV-NAME': devId,
      'X-EBAY-API-CERT-NAME': certId,
      'X-EBAY-API-IAF-TOKEN': accessToken,
    },
    payload: xmlBody,
    muteHttpExceptions: true,
  };
  var res = UrlFetchApp.fetch('https://api.ebay.com/ws/api.dll', options);
  var root = XmlService.parse(res.getContentText()).getRootElement();
  var ack = _xmlChildText(root, 'Ack');
  if (ack === 'Failure' || ack === 'PartialFailure') {
    var errors = root.getChildren('Errors', EBAY_NS);
    var msgs = errors.map(function (err) {
      return _xmlChildText(err, 'ShortMessage') + ' / ' + _xmlChildText(err, 'LongMessage');
    });
    throw new Error(callName + ' が失敗しました: ' + msgs.join(' | '));
  }
  return root;
}

// ===================================================================
// 自社出品一覧の取得（GetMyeBaySelling）
// View数・説明文はここでは取らない（別APIまたは別呼び出しで後から補う）
// ===================================================================
function fetchOwnListings() {
  var pageSize = 200;
  var page = 1;
  var listings = [];

  while (true) {
    var xmlBody =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">' +
      '<ActiveList><Include>true</Include>' +
      '<Pagination><EntriesPerPage>' + pageSize + '</EntriesPerPage><PageNumber>' + page + '</PageNumber></Pagination>' +
      '</ActiveList><DetailLevel>ReturnAll</DetailLevel>' +
      '</GetMyeBaySellingRequest>';

    var root = callTradingApi('GetMyeBaySelling', xmlBody);
    var active = root.getChild('ActiveList', EBAY_NS);
    if (!active) break;
    var itemArray = active.getChild('ItemArray', EBAY_NS);
    var items = itemArray ? itemArray.getChildren('Item', EBAY_NS) : [];
    if (items.length === 0) break;

    items.forEach(function (it) {
      var sellingStatus = it.getChild('SellingStatus', EBAY_NS);
      var listingDetails = it.getChild('ListingDetails', EBAY_NS);
      var pictureDetails = it.getChild('PictureDetails', EBAY_NS);
      var primaryCategory = it.getChild('PrimaryCategory', EBAY_NS);
      var itemId = _xmlChildText(it, 'ItemID');
      var priceNode = sellingStatus ? sellingStatus.getChild('CurrentPrice', EBAY_NS) : null;
      var price = priceNode ? parseFloat(priceNode.getText()) : null;

      // 【重要】GetMyeBaySellingは、DetailLevel=ReturnAllでもPrimaryCategoryを
      // 返してくれない（実データで確認済み・2026-09-01）。そのため、
      // ViewItemURLForNaturalSearchに埋め込まれているcategory=数字のIDを
      // 代わりに使う（追加のAPI呼び出し不要）。カテゴリ名（表示用）は、
      // 最終的に候補に選ばれた商品だけ、fetchItemDetails()でGetItemを呼ぶ際に
      // 一緒に取得して上書きする。
      var naturalSearchUrl = _xmlChildText(listingDetails, 'ViewItemURLForNaturalSearch');
      var categoryIdMatch = naturalSearchUrl.match(/[?&]category=(\d+)/);
      var categoryName = _xmlChildText(primaryCategory, 'CategoryName')
        || (categoryIdMatch ? categoryIdMatch[1] : '')
        || _xmlChildText(primaryCategory, 'CategoryID')
        || '未分類';

      listings.push({
        itemId: itemId,
        name: _xmlChildText(it, 'Title'),
        price: price,
        listedDate: _xmlChildText(listingDetails, 'StartTime'),
        categoryName: categoryName,
        imageUrl: _xmlChildText(pictureDetails, 'GalleryURL'),
        itemUrl: _xmlChildText(listingDetails, 'ViewItemURL') || ('https://www.ebay.com/itm/' + itemId),
        sku: _xmlChildText(it, 'SKU'), // 出品に登録したSKU（未設定の商品は空文字。2026-09-10追加）
        description: '', // 候補に選ばれた後、fetchItemDetails()で個別に取得する
      });
    });

    var pagination = active.getChild('PaginationResult', EBAY_NS);
    var totalPages = pagination ? parseInt(_xmlChildText(pagination, 'TotalNumberOfPages') || '1', 10) : 1;
    if (page >= totalPages) break;
    page++;
  }
  return listings;
}

// ===================================================================
// 出品URLの短縮（TinyURL。APIキー不要の無料APIで、候補に選ばれた商品だけ呼ぶので低頻度）。
// 失敗した場合は元のURLをそのまま使う（投稿文自体は作れなくならないようにする）。
// ===================================================================
function shortenUrl(longUrl) {
  try {
    var res = UrlFetchApp.fetch('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(longUrl), {
      muteHttpExceptions: true,
    });
    var text = (res.getContentText() || '').trim();
    if (res.getResponseCode() === 200 && text.indexOf('http') === 0) {
      return text;
    }
    Logger.log('shortenUrl: 想定外のレスポンスのため元のURLを使用します: ' + text);
  } catch (e) {
    Logger.log('shortenUrl失敗（元のURLを使用します）: ' + e);
  }
  return longUrl;
}

// ===================================================================
// 商品説明＋カテゴリ名の取得（GetItem。候補に選ばれた商品だけ、必要な時に呼ぶ）
//
// カテゴリ名は本来fetchOwnListings側で取りたいが、GetMyeBaySellingが
// PrimaryCategoryを返してくれないため、ここ（GetItem）でまとめて取得する。
// OutputSelectorにPrimaryCategoryを追加しても、Descriptionと合わせて
// 呼び出し回数は変わらない（同じ1回のGetItem呼び出しに乗せているだけ）。
// ===================================================================
// 【2026-09-02追加】OutputSelectorにPictureDetailsも追加し、GalleryURL（一覧取得時の
// 小さいサムネイル。Instagram投稿用画像がぼやける原因だった）ではなく、実際の商品写真
// （PictureURL、フルサイズ）を取得する。候補に選ばれた商品だけの呼び出しなので追加コストは小さい。
function fetchItemDetails(itemId) {
  var xmlBody =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">' +
    '<ItemID>' + itemId + '</ItemID>' +
    '<DetailLevel>ReturnAll</DetailLevel>' +
    '<OutputSelector>Description,PrimaryCategory,PictureDetails</OutputSelector>' +
    '</GetItemRequest>';
  var root = callTradingApi('GetItem', xmlBody);
  var item = root.getChild('Item', EBAY_NS);
  var primaryCategory = item ? item.getChild('PrimaryCategory', EBAY_NS) : null;
  var pictureDetails = item ? item.getChild('PictureDetails', EBAY_NS) : null;
  var pictureUrls = pictureDetails ? pictureDetails.getChildren('PictureURL', EBAY_NS) : [];
  return {
    description: _xmlChildText(item, 'Description'),
    categoryName: _xmlChildText(primaryCategory, 'CategoryName') || '',
    pictureUrl: pictureUrls.length ? pictureUrls[0].getText() : '',
  };
}

// ===================================================================
// View数の取得（Sell Analytics API / traffic_report）
// 【要注意】このAPIだけ別枠のクォータで1日100回まで。
// 出品IDが200件だとfilterのURLが長すぎてGASの制限に引っかかったため、80件ずつに分割する。
//
// 【クォータ節約策】
// 1) 一度取得したView数は「出品ID単位」で6時間キャッシュする。テスト中に
//    dailyRun()を何度も再実行しても、同じ出品IDの分はAPIを呼ばずキャッシュ
//    から返す（＝実質クォータを消費しない）。
// 2) 実際にAPIへ発行した回数を自分で数えて記録する（ANALYTICS_CALLS_YYYYMMDD）。
//    eBay公式のクォータ表示ではなくこのスクリプトからの呼び出し回数だけの
//    カウントだが、上限（100件/日）に近づいたら実行前に止めて、また
//    「Too many requests」エラーを踏むのを防ぐ。
// ===================================================================
// 【ebay-price-checker優先】
// traffic_reportの公式上限は100件/日だが、同じeBay Developerアプリ（App ID/Cert ID）を
// 使うebay-price-checkerのAPI利用を最優先するため、このアプリ自身は1日10回までに
// 自主的に制限する（本番の日次実行で実際に必要なのは通常1〜2回程度のはず）。
var ANALYTICS_DAILY_SAFE_LIMIT = 10;

function _analyticsCallCountKey() {
  return 'ANALYTICS_CALLS_' + Utilities.formatDate(new Date(), 'Etc/UTC', 'yyyyMMdd');
}

function getAnalyticsCallsUsedToday() {
  var props = PropertiesService.getScriptProperties();
  return Number(props.getProperty(_analyticsCallCountKey()) || '0');
}

function _recordAnalyticsCall() {
  var props = PropertiesService.getScriptProperties();
  var key = _analyticsCallCountKey();
  var used = Number(props.getProperty(key) || '0') + 1;
  props.setProperty(key, String(used));
  return used;
}

// ===================================================================
// View数の「最後に成功した値」を長期保存するフォールバック（PropertiesService）
//
// CacheServiceの6時間キャッシュだけだと、当日のtraffic_reportクォータが
// 尽きた瞬間からdailyRun()が候補ゼロを返し続けてしまう（実際に2026-09-02、
// GitHub Pages公開後の初回本番実行で発生した「0/0 本日の候補はありません」の
// 原因はこれ）。そこでAnalytics APIの呼び出しに成功するたびに
// 「出品ID→View数・取得日時」をPropertiesServiceにも保存しておき、
// 当日クォータ切れ等でAPIが呼べない時は、この最後に成功した値（多少古くても）
// を代わりに使う。「何もないよりは、数日前のView数の方がまだ役に立つ」という考え方。
// ===================================================================
var LAST_KNOWN_VIEWS_PROP = 'LAST_KNOWN_VIEWS_JSON';
var LAST_KNOWN_VIEWS_MAX_AGE_DAYS = 5;

function _loadLastKnownViews() {
  var raw = PropertiesService.getScriptProperties().getProperty(LAST_KNOWN_VIEWS_PROP);
  return raw ? JSON.parse(raw) : {};
}

function _saveLastKnownViews(map) {
  try {
    PropertiesService.getScriptProperties().setProperty(LAST_KNOWN_VIEWS_PROP, JSON.stringify(map));
  } catch (e) {
    // スクリプトプロパティ1件あたり9KBの上限を超えた場合は、古い順に間引いて再保存する
    var entries = Object.keys(map).map(function (id) { return [id, map[id]]; });
    entries.sort(function (a, b) { return b[1].ts - a[1].ts; });
    var trimmed = {};
    entries.slice(0, Math.floor(entries.length * 0.7)).forEach(function (e2) { trimmed[e2[0]] = e2[1]; });
    Logger.log('LAST_KNOWN_VIEWS: サイズ上限のため件数を間引いて再保存しました（' + entries.length + '→' + Object.keys(trimmed).length + '件）');
    PropertiesService.getScriptProperties().setProperty(LAST_KNOWN_VIEWS_PROP, JSON.stringify(trimmed));
  }
}

function _getLastKnownView(itemId) {
  var entry = _loadLastKnownViews()[itemId];
  if (!entry) return null;
  var ageDays = (Date.now() - entry.ts) / (1000 * 60 * 60 * 24);
  if (ageDays > LAST_KNOWN_VIEWS_MAX_AGE_DAYS) return null;
  return entry.views;
}

// meta（呼び出し元と共有するオブジェクト）に、今回クォータ制限に引っかかったか・
// 過去の値で代用したかを書き込む。dailyRun()側でメール通知に使う。
function fetchViewCounts(itemIds, meta) {
  meta = meta || {};
  meta.quotaIssue = null;
  meta.usedFallback = false;
  if (!itemIds || itemIds.length === 0) return {};
  var cache = CacheService.getScriptCache();
  var result = {};
  var toFetch = [];

  // ---- まずキャッシュ（6時間有効）から埋められるだけ埋める ----
  var cacheKeys = itemIds.map(function (id) { return 'VIEWS_' + id; });
  var cached = cache.getAll(cacheKeys);
  itemIds.forEach(function (id) {
    var v = cached['VIEWS_' + id];
    if (v !== undefined && v !== null) {
      result[id] = Number(v);
    } else {
      toFetch.push(id);
    }
  });

  if (toFetch.length === 0) {
    Logger.log('View数: 全' + itemIds.length + '件キャッシュ済みのためAPI呼び出しなし');
    return result;
  }
  Logger.log('View数: ' + (itemIds.length - toFetch.length) + '件キャッシュ済み / ' + toFetch.length + '件をAPIへ問い合わせ');

  var chunkSize = 80;
  var chunksNeeded = Math.ceil(toFetch.length / chunkSize);
  var usedSoFar = getAnalyticsCallsUsedToday();
  var quotaBlocked = (usedSoFar + chunksNeeded > ANALYTICS_DAILY_SAFE_LIMIT);
  if (quotaBlocked) {
    meta.quotaIssue = '今日のtraffic_report呼び出し回数（このスクリプトからの記録上で' + usedSoFar + '回）が' +
      '安全上限（' + ANALYTICS_DAILY_SAFE_LIMIT + '回）に近いため、今回のAPI呼び出しをスキップしました。';
    Logger.log(meta.quotaIssue);
  }

  var newlyFetched = {};
  var apiFailed = false;

  if (!quotaBlocked) {
    var accessToken = getEbayAccessToken();
    var end = new Date();
    end.setDate(end.getDate() - 2); // eBay側のタイムゾーン差対策で2日前を終端にする
    var start = new Date(end);
    start.setDate(start.getDate() - 30);
    var fmt = function (d) { return Utilities.formatDate(d, 'Etc/UTC', 'yyyyMMdd'); };
    var dateRange = '[' + fmt(start) + '..' + fmt(end) + ']';

    for (var i = 0; i < toFetch.length; i += chunkSize) {
      if (apiFailed) break; // 一度失敗したら、以降のバッチも同じ理由（クォータ切れ等）で
                             // 失敗する可能性が高いので、無駄な呼び出しを打ち切る
      var batch = toFetch.slice(i, i + chunkSize);
      var filter = 'marketplace_ids:{EBAY_US},date_range:' + dateRange + ',listing_ids:{' + batch.join('|') + '}';
      var url = 'https://api.ebay.com/sell/analytics/v1/traffic_report'
        + '?dimension=LISTING'
        + '&filter=' + encodeURIComponent(filter)
        + '&metric=' + encodeURIComponent('LISTING_IMPRESSION_TOTAL,LISTING_VIEWS_TOTAL,TRANSACTION');

      var options = {
        method: 'get',
        headers: { Authorization: 'Bearer ' + accessToken },
        muteHttpExceptions: true,
      };
      var res = UrlFetchApp.fetch(url, options);
      var used = _recordAnalyticsCall();
      if (res.getResponseCode() >= 400) {
        meta.quotaIssue = 'traffic_reportの取得に失敗しました（' + used + '回目の呼び出し）: ' + res.getContentText();
        Logger.log(meta.quotaIssue);
        apiFailed = true;
        break;
      }
      var data = JSON.parse(res.getContentText());
      var metricKeys = ((data.header || {}).metrics || []).map(function (m) { return m.key; });
      // 該当期間にViewが0件だった出品はrecordsに出てこないので、まずbatch全員を0で初期化
      batch.forEach(function (id) { newlyFetched[id] = 0; });
      (data.records || []).forEach(function (rec) {
        var dims = rec.dimensionValues || [];
        if (!dims.length) return;
        var itemId = dims[0].value;
        var values = {};
        (rec.metricValues || []).forEach(function (mv, idx) {
          values[metricKeys[idx]] = Number(mv.value) || 0;
        });
        newlyFetched[itemId] = values.LISTING_VIEWS_TOTAL || 0;
      });
    }
  }

  // ---- 新規取得分をキャッシュ（6時間）＋長期フォールバック用（PropertiesService）に保存 ----
  var toCache = {};
  var lastKnown = _loadLastKnownViews();
  var now = Date.now();
  Object.keys(newlyFetched).forEach(function (id) {
    result[id] = newlyFetched[id];
    toCache['VIEWS_' + id] = String(newlyFetched[id]);
    lastKnown[id] = { views: newlyFetched[id], ts: now };
  });
  if (Object.keys(toCache).length > 0) {
    cache.putAll(toCache, 21600);
    _saveLastKnownViews(lastKnown);
  }

  // ---- クォータ切れ・API失敗で今回取れなかった分は、期限内（5日以内）の
  //      「最後に成功した値」があればそれで代用する ----
  if (quotaBlocked || apiFailed) {
    var stillMissing = toFetch.filter(function (id) { return result[id] === undefined; });
    var fallbackCount = 0;
    stillMissing.forEach(function (id) {
      var fallback = _getLastKnownView(id);
      if (fallback !== null) {
        result[id] = fallback;
        fallbackCount++;
      }
    });
    if (fallbackCount > 0) {
      meta.usedFallback = true;
      Logger.log('View数: ' + fallbackCount + '件を過去の取得値（最大' + LAST_KNOWN_VIEWS_MAX_AGE_DAYS + '日以内）で代用しました');
    }
  }

  return result;
}

// ===================================================================
// 候補プールの元になる出品一覧（自社出品＋View数）をまとめて取得
//
// 【重要】全出品（数千件規模になりうる）にView数取得（Analytics API）を
// 呼ぶと実行時間の上限（6分）を超えてしまうため、先に「settings.days以内に
// 出品したもの」だけに絞り込んでから、その分だけView数を取得する。
// View数取得は候補選定に必須の情報だが、期間外の出品はそもそも候補に
// ならないので、ここで削って呼び出し件数を大きく減らす。
//
// 【重要・ebay-price-checker優先】
// GetMyeBaySelling（Trading API）も、ebay-price-checkerと同じApp ID/Cert IDを
// 共有しているため、このアプリの都合だけで何度も呼ぶのは避ける。
// 直近settings.days以内に絞り込んだ結果を3時間キャッシュし、同じ日のうちに
// dailyRun()やdailyRunDryRun()を何度再実行してもTrading APIを再度叩かないようにする。
function getRecentOwnListingsCached() {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'RECENT_LISTINGS_' + Utilities.formatDate(new Date(), 'Etc/UTC', 'yyyyMMdd');
  var cached = cache.get(cacheKey);
  if (cached) {
    var restored = JSON.parse(cached);
    Logger.log('直近出品一覧: キャッシュから復元（' + restored.length + '件、Trading APIは呼びません）');
    return restored;
  }

  var t0 = new Date().getTime();
  var listings = fetchOwnListings();
  Logger.log('fetchOwnListings: ' + listings.length + '件 / ' + (new Date().getTime() - t0) + 'ms');

  var settings = getSettings();
  var now = new Date();
  var recentListings = listings.filter(function (l) {
    var listedDaysAgo = Math.floor((now - new Date(l.listedDate)) / (1000 * 60 * 60 * 24));
    return listedDaysAgo <= settings.days;
  });
  Logger.log('直近' + settings.days + '日以内に絞り込み: ' + recentListings.length + '件');

  try {
    cache.put(cacheKey, JSON.stringify(recentListings), 10800); // 3時間
  } catch (e) {
    Logger.log('直近出品一覧のキャッシュ保存をスキップ（サイズ超過の可能性）: ' + e);
  }
  return recentListings;
}

function fetchEbayListings(meta) {
  var recentListings = getRecentOwnListingsCached();

  var t1 = new Date().getTime();
  var itemIds = recentListings.map(function (l) { return l.itemId; });
  var viewsMap = fetchViewCounts(itemIds, meta);
  Logger.log('fetchViewCounts: ' + (new Date().getTime() - t1) + 'ms');

  recentListings.forEach(function (l) {
    l.views = viewsMap[l.itemId] || 0;
  });
  return recentListings;
}

// ===================================================================
// 候補プールの抽出（要件定義4章）
// ===================================================================
function filterCandidatePool(listings) {
  var settings = getSettings();
  var now = new Date();
  return listings.filter(function (item) {
    if (isPosted(item.itemId)) return false;
    if (isSkipped(item.itemId)) return false; // 見送り済みも二度と候補に出さない（2026-09-02〜）
    var listedDaysAgo = Math.floor((now - new Date(item.listedDate)) / (1000 * 60 * 60 * 24));
    if (listedDaysAgo > settings.days) return false;
    if (item.views < settings.minViews) return false;
    item._listedDaysAgo = listedDaysAgo;
    return true;
  });
}

// ===================================================================
// ジャンル分散ロジック（ラウンドロビン、view数優先。要件定義4章）
// ===================================================================
function selectCandidatesByGenreRoundRobin(pool, count) {
  var groups = {};
  pool.forEach(function (item) {
    var genre = item.categoryName || '未分類';
    if (!groups[genre]) groups[genre] = [];
    groups[genre].push(item);
  });
  Object.keys(groups).forEach(function (g) {
    groups[g].sort(function (a, b) { return b.views - a.views; });
  });

  var genreOrder = Object.keys(groups).sort(function (a, b) {
    return groups[b][0].views - groups[a][0].views;
  });

  // 「1周」＝genreOrderの順番で、まだ在庫があるジャンルから1件ずつ選ぶ、を
  // countに達するまで繰り返す。（元の実装は、ジャンルの在庫が減って
  // remainingGenres配列の長さが変わるたびにcursorの意味がズレてしまい、
  // 同じジャンルが2回選ばれる一方で別のジャンルが1件も選ばれない、という
  // バグがあったため書き直した。test_logic.jsで再現・修正確認済み）
  var selected = [];
  while (selected.length < count) {
    var pickedThisRound = false;
    for (var i = 0; i < genreOrder.length && selected.length < count; i++) {
      var genre = genreOrder[i];
      if (groups[genre] && groups[genre].length > 0) {
        selected.push(groups[genre].shift());
        pickedThisRound = true;
      }
    }
    if (!pickedThisRound) break; // 全ジャンル在庫切れ
  }
  return selected;
}

// ===================================================================
// Claude Haiku APIで、投稿文の素材（IG用の短いひとこと=hook・X用の説明=recommendPoint・
// ハッシュタグ候補=hashtags）をまとめて1回のAPI呼び出しで生成する（要件定義1章・5章）。
//
// 【2026-09-02改修】以前はrecommendPointだけをプレーンテキストで要求していたが、
// 見出し禁止の指示がなかったため、Claudeが「# Recommend Point」のようなMarkdown見出しを
// 本文の先頭に付けてくることがあり（フェーズ0のつまずきメモに記載済み）、実際に承認アプリの
// 本文が「#Recommend...」から始まる不自然な表示になっていた。またIG用の短いhookと
// ハッシュタグ候補は要件定義にありながら未実装（hookはrecommendPointの使い回し、
// hashtagsは常に空配列）だった。
// 今回、JSON形式での出力を明示指定し、見出し・Markdown記法・ハッシュタグを本文から除外した
// 上で、hook・recommendPoint・hashtagsの3点を1回のAPI呼び出しでまとめて生成するように変更。
//
// 【2026-09-26改修】①本文の中身を「商品説明」から「購入したらどんな良いことがあるか・
// どんな気持ちになるか・どんな場面で活躍するか」を伝えて購買意欲をそそる文章に変更。
// ②Xは文字数上限（280・重み付き）からタイトル・URL・ハッシュタグを引いた残りが本文の
// 上限になるため、以前は長めの本文が生成され、フロント側で文の途中や後半がばっさり
// 省略されることがあった。そこで商品ごとに本文の上限文字数を計算してClaudeに伝え、
// 生成後も実際の文字数を確認し、超えていれば短く書き直させる（最大2回）ようにした。
// ===================================================================
var X_URL_WEIGHT = 23;        // フロント（buildXCaption）と同じ値にすること
var X_HASHTAG_COUNT = 3;      // 同上
var CAPTION_EMOJI = '🏷️';     // フロント（mapCandidateのemoji）と同じ値にすること
var IG_BODY_MAX_CHARS = 450;  // Instagram本文の目安上限（公式上限2200より十分短く、読み切れる長さ）

// Xの重み付き文字数（フロントのxWeightedLengthと同じ計算方法：半角1・それ以外2）
function xWeightedLength(str) {
  var len = 0;
  for (var ch of String(str || '')) {
    len += ch.charCodeAt(0) > 0x7F ? 2 : 1;
  }
  return len;
}

// X投稿のうち本文（recommendPoint）に使える文字数。フロントのbuildXCaptionと同じ
// 構成（タイトル／本文／URL／ハッシュタグを空行で区切る）で計算する。
function computeXBodyBudget(itemName, hashtags) {
  var limit = getSettings().xCharLimit || 280;
  var header = CAPTION_EMOJI + ' ' + itemName;
  var tagLine = (hashtags || []).slice(0, X_HASHTAG_COUNT).join(' ');
  var fixed = xWeightedLength(header) + 2 + 2 + X_URL_WEIGHT + 2 + xWeightedLength(tagLine);
  return limit - fixed;
}

function callClaude(prompt, maxTokens) {
  var apiKey = PropertiesService.getScriptProperties().getProperty(PROP.CLAUDE_API_KEY);
  if (!apiKey) throw new Error('Claude APIキーがスクリプトプロパティに設定されていません。');
  var payload = {
    model: 'claude-haiku-4-5',
    max_tokens: maxTokens || 800,
    messages: [{ role: 'user', content: prompt }],
  };
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', options);
  var json = JSON.parse(res.getContentText());
  return (json.content && json.content[0]) ? json.content[0].text : '';
}

// 共通の文章方針（IG・X共通）
var COPYWRITING_RULES =
  'Copywriting approach: do not just describe or list specs. Make the reader want to own it: ' +
  'show the benefit of owning it, how it will make them feel when they wear or use it, and a concrete ' +
  'scene or occasion where it shines (for example a weekend in the city, a trip, a date, the office, ' +
  'layering on a cold morning — choose what truly fits this item). Use one or two concrete facts from the ' +
  'product information (brand, era, material, a design detail) as proof of why it is special. ' +
  'Use ONLY facts found in the product information below; never invent condition, authenticity, ' +
  'measurements, rarity or history that is not stated. Warm, confident, natural tone; no clichés like ' +
  '"Don\'t miss out", at most one exclamation mark, no emojis, no em dashes (use commas instead). ' +
  'Every sentence must be complete and end with ".", "!" or "?". Plain text only: no heading, no markdown, ' +
  'no hashtags, no line breaks, no quotation marks.';

function summarizeWithClaude(description, itemName, categoryName) {
  // ハッシュタグは生成前には分からないため、3個分で約50文字と見積もって余裕を持たせた上限を伝える。
  var estimatedXBudget = Math.max(60, computeXBodyBudget(itemName, []) - 50);

  var prompt = 'You are an experienced copywriter for a Japanese reseller of vintage and designer fashion, ' +
    'writing English social media posts for an eBay listing aimed at international buyers. Return ONLY ' +
    'valid JSON (no markdown, no code fences, no extra text before or after) with exactly these three keys:\n' +
    '- "hook": the Instagram caption body. 3 to 4 complete sentences, at most ' + IG_BODY_MAX_CHARS +
    ' characters in total.\n' +
    '- "recommendPoint": the X (Twitter) post body. 1 or 2 complete sentences, at most ' + estimatedXBudget +
    ' characters in total including spaces and punctuation. This limit is strict: write it to fit, do not ' +
    'write something longer that would need to be cut.\n' +
    '- "hashtags": an array of 10 English hashtags for this specific product. Each one should be either ' +
    '(a) a concrete word describing this product\'s actual characteristics (brand, material, style, ' +
    'era/decade, color, silhouette, notable design detail, condition), or (b) a word that genuinely ' +
    'boosts buyer appeal/desirability for this kind of item (only if it truly fits the product — never ' +
    'generic filler). Base these on the product name, category and description below, not on a generic ' +
    'template. Order from most to least relevant. Each item must start with "#", contain no spaces, and ' +
    'use CamelCase for multi-word tags (example: "#VintageJacket"). Keep the first three short. Do not ' +
    'include a hashtag containing the words "Recommend" or "Point" — those are internal field names.\n\n' +
    COPYWRITING_RULES + '\n\n' +
    'Product: ' + itemName + '\nCategory: ' + (categoryName || '') + '\nDescription:\n' + description;

  var material = parseCaptionMaterial(callClaude(prompt, 800), itemName);
  material.recommendPoint = fitXBody(material.recommendPoint, itemName, material.hashtags);
  return material;
}

// 実際に決まったハッシュタグで本文の上限を正確に計算し直し、超えていれば
// Claudeに短く書き直させる（最大2回）。それでも超える場合だけ、文の区切りで
// 完全な文までを残す（文の途中では切らない）。
function fitXBody(text, itemName, hashtags) {
  var budget = computeXBodyBudget(itemName, hashtags);
  var current = text || '';
  for (var attempt = 0; attempt < 2 && xWeightedLength(current) > budget; attempt++) {
    var target = budget - 10; // 少し余裕を持たせる
    var prompt = 'Rewrite the following X (Twitter) post body so that it is at most ' + target +
      ' characters in total, including spaces and punctuation. Keep it persuasive (benefit, feeling, or ' +
      'a scene where the item shines), keep it as 1 or 2 complete sentences each ending with ".", "!" or ' +
      '"?", and do not add any new facts. Plain text only: no hashtags, no quotation marks, no line breaks, ' +
      'no emojis, no em dashes. Return ONLY the rewritten text.\n\nProduct: ' + itemName +
      '\nText to rewrite:\n' + current;
    var rewritten = (callClaude(prompt, 300) || '').trim().replace(/^["']|["']$/g, '');
    if (rewritten) current = rewritten;
  }
  if (xWeightedLength(current) > budget) {
    Logger.log('fitXBody: 書き直し後も上限超過のため文の区切りで調整（' + itemName + '）');
    current = cutAtSentence(current, budget) || current;
  }
  return current;
}

function cutAtSentence(text, budget) {
  var re = /[.!?]/g;
  var best = '';
  var m;
  while ((m = re.exec(text)) !== null) {
    var candidate = text.slice(0, m.index + 1).trim();
    if (xWeightedLength(candidate) <= budget) best = candidate; else break;
  }
  return best;
}

// Claudeの応答（本来はJSON文字列）を安全にパースする。プロンプトで禁止していても、
// 万一```json```のようなコードフェンス付きで返ってきたり、JSONとして壊れていたりする
// 場合に備えて、フォールバック（見出し記法だけ取り除いて本文としてそのまま使う）も用意する。
function parseCaptionMaterial(raw, itemName) {
  var cleaned = (raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    var parsed = JSON.parse(cleaned);
    return {
      hook: (parsed.hook || '').toString().trim(),
      recommendPoint: (parsed.recommendPoint || '').toString().trim(),
      hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.filter(function (h) { return !!h; }) : [],
    };
  } catch (e) {
    Logger.log('summarizeWithClaude: JSON解析に失敗したためフォールバックしました（' + itemName + '）: ' + e);
    var text = cleaned.replace(/^#+\s*/gm, '').trim(); // 見出し記法（#）だけ除去
    return { hook: (text.split(/[.!?]/)[0] || text).trim(), recommendPoint: text, hashtags: [] };
  }
}

// ===================================================================
// 日次実行（時間主導トリガーから呼ぶ本体。要件定義1章・11章）
// ===================================================================
// options.skipEmail: trueなら候補の通知メールを送らない（承認アプリの🔄から動かした時用。
// アプリを開いている本人に「候補があります」とメールを送る意味がないため。2026-09-26追加）。
// ※時間主導トリガーから呼ばれた時は、GASがトリガーの情報を第1引数に渡してくるが、
// skipEmailは含まれないので通常どおりメールを送る。
// 戻り値：{ ok: true, count: 件数 } または { ok: false, error: 'エラー内容' }（🔄の結果表示用）
// 【2026-10-11追加】実行状況の記録と二重実行の防止。
// 承認アプリの🔄は1〜2分かかるため、待っている間にスマホの画面を切り替えたりロックしたりすると、
// アプリ側の通信だけが切れて（GAS側の処理は最後まで動いて候補は作られているのに）結果を
// 受け取れず、古い一覧（投稿済みを除くと0件）が表示されることがあった。そこで実行状況を
// RUN_STATUSに記録し、アプリ側は通信が切れても完了するまで状況を確認し続けられるようにした。
// また毎朝のトリガーと🔄が重なった場合などに、2つの処理が同時に候補を書き換えないよう
// LockServiceで1本ずつに制限する。
// options.runId：アプリ側で発行した実行ID（完了確認用）。トリガーから呼ばれた時はなし。
function dailyRun(options) {
  var skipEmail = !!(options && options.skipEmail === true);
  var runId = (options && typeof options.runId === 'string' && options.runId) ? options.runId : ('auto-' + Date.now());
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) {
    var current = getRunStatus();
    Logger.log('dailyRun: 別の実行中のためスキップしました（実行中ID: ' + current.runId + '）');
    return { ok: false, busy: true, runId: current.runId || '', error: '別の候補作成がすでに実行中です' };
  }
  var startedAt = Date.now();
  setRunStatus({ runId: runId, state: 'running', startedAt: startedAt });
  var result;
  try {
    result = dailyRunInner(skipEmail);
  } catch (e) {
    result = { ok: false, error: (e && e.message) ? e.message : String(e) };
  } finally {
    setRunStatus({
      runId: runId,
      state: (result && result.ok) ? 'done' : 'error',
      startedAt: startedAt,
      finishedAt: Date.now(),
      count: result && result.count,
      poolSize: result && result.poolSize,
      error: (result && result.error) || '',
    });
    lock.releaseLock();
  }
  result.runId = runId;
  return result;
}

function setRunStatus(status) {
  PropertiesService.getScriptProperties().setProperty(PROP.RUN_STATUS, JSON.stringify(status));
}

function getRunStatus() {
  var raw = PropertiesService.getScriptProperties().getProperty(PROP.RUN_STATUS);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

// アプリに返す実行状況。GASの実行時間上限（6分）で強制終了された場合は'running'のまま
// 残ってしまうため、7分以上経っている'running'はエラー扱いにして返す。
function getRunStatusForClient() {
  var st = getRunStatus();
  if (st.state === 'running' && st.startedAt && Date.now() - st.startedAt > 7 * 60 * 1000) {
    st.state = 'error';
    st.error = '時間がかかりすぎたため中断されました';
  }
  return st;
}

// 戻り値：{ ok: true, count: 作成した件数, poolSize: 条件に合った未投稿の商品数 }
//        または { ok: false, error: 'エラー内容' }
function dailyRunInner(skipEmail) {
  var props = PropertiesService.getScriptProperties();

  if (isInactiveBeyondThreshold()) {
    if (props.getProperty(PROP.AUTO_STOPPED) !== 'true') {
      props.setProperty(PROP.AUTO_STOPPED, 'true');
    }
    if (props.getProperty(PROP.STOP_NOTIFIED) !== 'true') {
      notifyAutoStopped();
      props.setProperty(PROP.STOP_NOTIFIED, 'true');
    }
    return { ok: false, error: '操作がない期間が続いたため自動取得を停止中です' }; // eBay・Claudeどちらも呼ばずに終了（課金なし）
  }

  // 【重要・2026-09-02追記】以前はここから先で例外が飛ぶと（主にtraffic_reportの
  // クォータ切れ）dailyRunがそのまま失敗して終了し、候補も保存されず通知メールも
  // 飛ばないため、ユーザー側からは「なぜか承認アプリが0/0のまま」としか見えなかった。
  // 今後は何が起きても（a）原因をメールで通知する、（b）View数取得だけが失敗した
  // 場合はできる限り候補を出す、の2点を優先する。
  var meta = {};
  try {
    var settings = getSettings();
    var listings = fetchEbayListings(meta);
    var pool = filterCandidatePool(listings);
    Logger.log('候補プール（未投稿・view条件クリア）: ' + pool.length + '件');
    var candidates = selectCandidatesByGenreRoundRobin(pool, settings.count);
    Logger.log('選出した候補: ' + candidates.length + '件');

    var t2 = new Date().getTime();
    candidates.forEach(function (c) {
      var details = fetchItemDetails(c.itemId);
      c.description = details.description;
      if (details.categoryName) c.categoryName = details.categoryName; // 数値IDより見やすい正式名に差し替え
      if (details.pictureUrl) c.imageUrl = details.pictureUrl; // 一覧取得時の小さいサムネイルをフルサイズ画像に差し替え
      // 出品URLの短縮（shortenUrl）は2026-09-05に「eBayへのリンクは短縮しないでほしい」との
      // 要望を受けて廃止した。関数自体は将来また必要になった場合のために残してある。
      var material = summarizeWithClaude(c.description, c.name, c.categoryName);
      c.hook = material.hook;
      c.recommendPoint = material.recommendPoint;
      c.hashtags = material.hashtags;
    });
    Logger.log('説明取得+AI要約: ' + (new Date().getTime() - t2) + 'ms');

    saveTodayCandidates(candidates);
    // 通知メールの送信に失敗しても、候補の保存自体は済んでいるので処理全体は成功扱いにする
    // （以前はここで例外になると、候補は更新されているのにエラー扱いになっていた）。
    if (!skipEmail) {
      try {
        sendDailyNotificationEmail(candidates.length, meta);
      } catch (mailErr) {
        Logger.log('通知メールの送信に失敗しました（候補の保存は完了済み）: ' + mailErr);
      }
    }
    Logger.log('dailyRun完了' + (meta.quotaIssue ? '（View数取得は一部制限あり／過去値で代用=' + meta.usedFallback + '）' : ''));
    return { ok: true, count: candidates.length, poolSize: pool.length };
  } catch (e) {
    Logger.log('dailyRunが失敗しました: ' + e);
    try {
      notifyDailyRunError(e, meta);
    } catch (mailErr) {
      Logger.log('エラー通知メールの送信にも失敗しました: ' + mailErr);
    }
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}

// 【2026-09-10修正】CacheServiceは最大6時間（21600秒）までしか保持できない仕様のため、
// 朝6〜7時に生成した候補が同じ日の昼12〜13時ごろに消えてしまう不具合があった
// （トリガーを朝に変更したことで顕在化）。当日中はずっと見られるよう、期限のない
// PropertiesServiceに保存する方式に変更した。
// PropertiesServiceは1プロパティあたり9KBまでの制限があるため、そのままでは候補件数が
// 多い日（設定上は最大10件）に収まらない可能性がある。そのため①フロント表示に使わない
// 重いフィールド（description等）を除いてから、②複数プロパティに分割（チャンク化）して
// 保存する。
function saveTodayCandidates(candidates) {
  // フロント（mapCandidate参照）が実際に使うフィールドだけに絞る。
  // description（eBayの生の商品説明。HTML込みで数KB〜になることがある）は
  // AI要約に使い終わった後は不要なので、ここで落とす。
  var slim = candidates.map(function (c) {
    return {
      itemId: c.itemId,
      name: c.name,
      price: c.price,
      categoryName: c.categoryName,
      imageUrl: c.imageUrl,
      itemUrl: c.itemUrl,
      sku: c.sku,
      views: c.views,
      _listedDaysAgo: c._listedDaysAgo,
      hook: c.hook,
      recommendPoint: c.recommendPoint,
      hashtags: c.hashtags,
    };
  });
  var json = JSON.stringify(slim);
  var props = PropertiesService.getScriptProperties();

  // 前回分の古いチャンクが残らないよう、件数が減った場合に備えて一旦全部消してから書き直す。
  var prevCount = parseInt(props.getProperty(PROP.TODAY_CANDIDATES_CHUNK_COUNT) || '0', 10);
  for (var i = 0; i < prevCount; i++) {
    props.deleteProperty(PROP.TODAY_CANDIDATES_CHUNK_PREFIX + i);
  }

  var chunkSize = 8000; // 9KB上限に対して余裕を持たせたサイズ
  var chunks = [];
  for (var pos = 0; pos < json.length; pos += chunkSize) {
    chunks.push(json.slice(pos, pos + chunkSize));
  }
  chunks.forEach(function (chunk, idx) {
    props.setProperty(PROP.TODAY_CANDIDATES_CHUNK_PREFIX + idx, chunk);
  });
  props.setProperty(PROP.TODAY_CANDIDATES_CHUNK_COUNT, String(chunks.length));
}

function loadTodayCandidates() {
  var props = PropertiesService.getScriptProperties();
  var count = parseInt(props.getProperty(PROP.TODAY_CANDIDATES_CHUNK_COUNT) || '0', 10);
  if (!count) return [];
  var json = '';
  for (var i = 0; i < count; i++) {
    json += props.getProperty(PROP.TODAY_CANDIDATES_CHUNK_PREFIX + i) || '';
  }
  try {
    return JSON.parse(json);
  } catch (e) {
    Logger.log('loadTodayCandidates: 保存済み候補のJSON解析に失敗しました: ' + e);
    return [];
  }
}

// ===================================================================
// 投稿画像に重ねる「枠」画像の保存（2026-09-24追加）
//
// これまで枠画像はブラウザのlocalStorageにしか保存されておらず、端末ごとに
// 1回設定が必要な仕様だった。ところが「投稿を見たら枠が付いていなかった」という
// 報告があり、⚙️設定画面を確認したところ枠が「未設定」に戻ってしまっていた
// （何らかの理由でブラウザ側のストレージが消えた模様。原因はブラウザ側の挙動で
// 特定できなかったが、過去にも同様に枠が消えて再アップロードが必要になった経緯がある）。
// ローカルストレージだけに依存する限り今後も再発しうるため、GAS側
// （PropertiesService）にも保存し、doGetで返すようにした。これにより、
// ブラウザ側の保存が消えても次回アプリを開いた時点で自動的に復元される。
// 画像データ（base64のdata URL）はTODAY_CANDIDATESと同様、9KB/プロパティの
// 上限に収まるようチャンク分割して保存する。
function saveFrameImage(dataUrl) {
  var props = PropertiesService.getScriptProperties();
  var prevCount = parseInt(props.getProperty(PROP.FRAME_IMAGE_CHUNK_COUNT) || '0', 10);
  for (var i = 0; i < prevCount; i++) {
    props.deleteProperty(PROP.FRAME_IMAGE_CHUNK_PREFIX + i);
  }
  var chunkSize = 8000;
  var chunks = [];
  for (var pos = 0; pos < dataUrl.length; pos += chunkSize) {
    chunks.push(dataUrl.slice(pos, pos + chunkSize));
  }
  chunks.forEach(function (chunk, idx) {
    props.setProperty(PROP.FRAME_IMAGE_CHUNK_PREFIX + idx, chunk);
  });
  props.setProperty(PROP.FRAME_IMAGE_CHUNK_COUNT, String(chunks.length));
}

function loadFrameImage() {
  var props = PropertiesService.getScriptProperties();
  var count = parseInt(props.getProperty(PROP.FRAME_IMAGE_CHUNK_COUNT) || '0', 10);
  if (!count) return '';
  var dataUrl = '';
  for (var i = 0; i < count; i++) {
    dataUrl += props.getProperty(PROP.FRAME_IMAGE_CHUNK_PREFIX + i) || '';
  }
  return dataUrl;
}

function clearFrameImage() {
  var props = PropertiesService.getScriptProperties();
  var count = parseInt(props.getProperty(PROP.FRAME_IMAGE_CHUNK_COUNT) || '0', 10);
  for (var i = 0; i < count; i++) {
    props.deleteProperty(PROP.FRAME_IMAGE_CHUNK_PREFIX + i);
  }
  props.deleteProperty(PROP.FRAME_IMAGE_CHUNK_COUNT);
}

// 通知メールの宛先（スクリプトの所有者＝ご自身のGmail）。
// 【2026-09-26修正】以前はSession.getActiveUser()を使っていたが、これは時間主導トリガーから
// 動く時はご自身のアドレスを返す一方、承認アプリ（Web App）経由で動く時は空文字を返す仕様のため、
// 「🔄今すぐ実行」から動かすと「受信者が指定されていません」というエラーで止まっていた。
// getEffectiveUser()は「このスクリプトを実行している持ち主」を返すので、どちらから動いても
// 同じアドレスになる。
function getOwnerEmail() {
  return Session.getEffectiveUser().getEmail() || Session.getActiveUser().getEmail();
}

function notifyAutoStopped() {
  var email = getOwnerEmail();
  MailApp.sendEmail(email, '【投稿候補チェック】自動取得を停止しました',
    'しばらく操作がなかったため、自動取得（eBay取得・AI要約）を停止しました。\n' +
    '承認アプリを開いて何か操作すると、次回から自動的に再開します。');
}

// meta.quotaIssueがあれば、View数APIが制限にかかったことをメール本文に書き添える。
// meta.usedFallbackがtrueなら、その一部は過去の取得値で代用したことも伝える。
// 【2026-09-02変更】①リンク先をGAS Web AppのURL（APIエンドポイント自体で、人間が開く画面では
// ない）から、承認アプリ本体（APPROVAL_APP_URL、GitHub Pages）に修正。②絵文字を少し使って
// メール本文を読みやすくした。
function sendDailyNotificationEmail(count, meta) {
  var email = getOwnerEmail();
  var note = '';
  if (meta && meta.quotaIssue) {
    note = '\n\n⚠️ 【お知らせ】本日はView数API（traffic_report）の呼び出し制限に達したため、' +
      (meta.usedFallback
        ? '一部の商品は過去に取得した値（最大' + LAST_KNOWN_VIEWS_MAX_AGE_DAYS + '日以内）で代用しています。'
        : '一部の商品のView数が反映されていない可能性があります（過去の値も見つかりませんでした）。') +
      '\n詳細: ' + meta.quotaIssue;
  }
  MailApp.sendEmail(email, '【投稿候補チェック】本日の候補が' + count + '件あります',
    '📦 本日の投稿候補が' + count + '件見つかりました！\n\n' +
    '👉 こちらから承認アプリを開いて確認してください：\n' + APPROVAL_APP_URL +
    note);
}

// dailyRunが例外で止まってしまった時に、症状（承認アプリが0/0のまま）だけでなく
// 原因（実際のエラーメッセージ）が分かるようにするための通知。
function notifyDailyRunError(e, meta) {
  var email = getOwnerEmail();
  var detail = (e && e.message) ? e.message : String(e);
  var quotaNote = (meta && meta.quotaIssue) ? ('（参考）View数APIの状況: ' + meta.quotaIssue + '\n\n') : '';
  MailApp.sendEmail(email, '【投稿候補チェック】本日の自動取得でエラーが発生しました',
    '毎日の自動取得（dailyRun）でエラーが発生し、候補を更新できませんでした。\n\n' +
    'エラー内容:\n' + detail + '\n\n' +
    quotaNote +
    'この状態が続く場合は、GASエディタで直接 dailyRun() や checkAnalyticsQuotaUsage() を実行して原因を確認してください。');
}

// ===================================================================
// アクセス制御（要件定義9章）
//
// 承認アプリはGitHub Pages上の公開URLで配信するため、URLを知っている人
// なら誰でも開けてしまう。そのため簡易パスワードで doGet / doPost を
// ガードする。パスワードは「プロジェクトの設定」→「スクリプト プロパティ」の
// ACCESS_PASSWORD に設定する（このコードには書かない）。
//
// 【重要】ACCESS_PASSWORDが未設定（空）の場合は、誰でも通す（＝アクセス制御
// なし）。パスワードを設定するまでは今まで通り動くので、設定を忘れて
// 完全にロックアウトすることはない。
// ===================================================================
function checkAccessPassword(pw) {
  var required = PropertiesService.getScriptProperties().getProperty(PROP.ACCESS_PASSWORD);
  if (!required) return true; // 未設定なら制限なし
  return pw === required;
}

// ===================================================================
// Web App エンドポイント（承認アプリから呼ばれる。要件定義2章）
// ===================================================================
function doGet(e) {
  var pw = e.parameter && e.parameter.pw;
  if (!checkAccessPassword(pw)) {
    return jsonResponse({ error: 'unauthorized' });
  }
  recordActivity();
  // 【2026-09-15修正】これまでloadTodayCandidates()の結果をそのまま返していたため、
  // 「投稿完了にする／見送る」を押した商品も、その日保存済みの候補リストには
  // そのまま残り続けていた（POSTED_IDS/SKIPPED_IDSへの記録はfilterCandidatePool経由で
  // 次回以降のdailyRun/今すぐ実行にしか反映されない）。そのため一度アプリを閉じて
  // 開き直すと、既に投稿済み・見送り済みにしたはずの商品がまた候補として表示されて
  // しまう不具合があった。doGetの時点でも改めて除外するよう修正。
  var candidates = loadTodayCandidates().filter(function (c) {
    return !isPosted(c.itemId) && !isSkipped(c.itemId);
  });
  // 【2026-09-24追加】枠画像もGAS側に保存しておき、doGetで返すようにした
  // （経緯はsaveFrameImageのコメント参照）。frameDataUrlが空文字の場合は
  // 「枠が未設定」と「まだGAS側に保存されていない（従来どおりこの端末の
  // localStorageのみで持っている）」の両方を意味するため、フロント側では
  // 空文字を「上書きしない」扱いにする。
  var frameDataUrl = loadFrameImage();
  // runStatus：🔄の実行状況（アプリ側で、通信が切れた後も完了を確認するために使う。2026-10-11追加）
  // codeVersion：アプリ側で自動アップデートが必要か判断するために使う（2026-10-11追加）
  return jsonResponse({ candidates: candidates, settings: getSettings(), frameDataUrl: frameDataUrl, runStatus: getRunStatusForClient(), codeVersion: CODE_VERSION });
}

function doPost(e) {
  var body = JSON.parse(e.postData.contents);
  if (!checkAccessPassword(body.pw)) {
    return jsonResponse({ error: 'unauthorized' });
  }
  recordActivity();

  if (body.action === 'markPosted') {
    addPostedId(body.itemId);
    return jsonResponse({ ok: true });
  }
  if (body.action === 'markSkipped') {
    addSkippedId(body.itemId);
    return jsonResponse({ ok: true });
  }
  if (body.action === 'saveSettings') {
    var updated = saveSettings(body.settings);
    return jsonResponse({ ok: true, settings: updated });
  }
  if (body.action === 'saveFrame') {
    // ⚙️設定画面で枠画像をアップロードした時に、localStorageへの保存に加えて
    // GAS側にも保存する（2026-09-24追加）。
    saveFrameImage(body.frameDataUrl || '');
    return jsonResponse({ ok: true });
  }
  if (body.action === 'clearFrame') {
    clearFrameImage();
    return jsonResponse({ ok: true });
  }
  if (body.action === 'runNow') {
    // 承認アプリの「🔄今すぐ実行」ボタンから呼ばれる。自動トリガーを待たず、
    // その場でdailyRunを同期実行して結果を返す（2026-09-12追加）。
    // 直前のrecordActivity()でLAST_ACTIVE_AT・AUTO_STOPPEDが更新済みのため、
    // 操作なし自動停止中だった場合もこの呼び出しで自動的に再開する。
    // 【2026-10-11】アプリ側から実行IDを受け取り、実行状況（RUN_STATUS）に記録する。
    // 別の実行中だった場合はbusy:trueとその実行IDを返し、アプリ側はそちらの完了を待つ。
    try {
      var runId = String(body.runId || '') || ('manual-' + Date.now());
      return jsonResponse(dailyRun({ skipEmail: true, runId: runId }));
    } catch (e) {
      return jsonResponse({ ok: false, error: (e && e.message) ? e.message : String(e) });
    }
  }

  return jsonResponse({ ok: false, error: 'unknown action' });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===================================================================
// 【テスト用】1つずつ動作確認するための関数。確認できたら消してOK。
// ===================================================================
function testAccessToken() {
  var token = getEbayAccessToken();
  Logger.log('アクセストークン取得成功。長さ: ' + token.length);
}

function testOwnListingsAndViews() {
  var listings = fetchEbayListings();
  Logger.log('取得件数: ' + listings.length);
  listings.slice(0, 5).forEach(function (l) {
    Logger.log(l.itemId + ' | ' + l.name + ' | views=' + l.views + ' | ' + l.listedDate);
  });
}

// View数API（Analytics）を一切呼ばずに、候補選定〜doGet確認までを試すための
// ショートカット。関数選択のプルダウンから直接これを実行すればよい。
// （dailyRunDryRunは引数が必要なため、GASのUIから直接実行できないのでこれを用意している）
function runDryRunTest() {
  dailyRunDryRun(false, true);
}

// 【診断用】カテゴリ（ジャンル）が「未分類」ばかりになる原因を調べるため、
// GetMyeBaySellingが実際に返してくる1件分の生XMLをそのままログに出す。
// Analytics APIは一切呼ばない、軽いTrading API呼び出し1回だけ。
function debugFirstItemXml() {
  var xmlBody =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">' +
    '<ActiveList><Include>true</Include>' +
    '<Pagination><EntriesPerPage>1</EntriesPerPage><PageNumber>1</PageNumber></Pagination>' +
    '</ActiveList><DetailLevel>ReturnAll</DetailLevel>' +
    '</GetMyeBaySellingRequest>';
  var root = callTradingApi('GetMyeBaySelling', xmlBody);
  var active = root.getChild('ActiveList', EBAY_NS);
  if (!active) {
    Logger.log('ActiveListが見つかりませんでした');
    return;
  }
  var itemArray = active.getChild('ItemArray', EBAY_NS);
  var items = itemArray ? itemArray.getChildren('Item', EBAY_NS) : [];
  if (items.length === 0) {
    Logger.log('Itemが1件も返ってきませんでした');
    return;
  }
  var xmlOutput = XmlService.getPrettyFormat();
  Logger.log(xmlOutput.format(items[0]));
}

// 今日、このスクリプトからtraffic_report（View数API）を何回呼んだかを確認する。
// ※eBay公式のクォータ表示ではなく、このスクリプト自身が数えた回数。
function checkAnalyticsQuotaUsage() {
  var used = getAnalyticsCallsUsedToday();
  Logger.log('今日のtraffic_report呼び出し回数（このスクリプト集計）: ' + used + ' / 安全上限' + ANALYTICS_DAILY_SAFE_LIMIT + '（実際の上限は100）');
}

// 【デバッグ用】出品一覧のキャッシュ（3時間有効）を強制的に消す。
// fetchOwnListings周りのロジックを直した直後、キャッシュが古いデータの
// ままだと修正が反映されているか確認できないので、そういう時に使う。
function clearListingsCache() {
  var cache = CacheService.getScriptCache();
  var key = 'RECENT_LISTINGS_' + Utilities.formatDate(new Date(), 'Etc/UTC', 'yyyyMMdd');
  cache.remove(key);
  Logger.log('出品一覧のキャッシュを削除しました（次回はTrading APIから取り直します）: ' + key);
}

// 【診断用・2026-09-02追加】実際のView数の分布を確認して、minViewsの妥当な値を
// 検討するための関数。直近settings.days日以内の出品について、View数の分布
// （閾値ごとの該当件数）と上位10件を出力する。
// 同日中はキャッシュ（Trading API 3時間・Analytics API 6時間）が効くため、
// dailyRun()やtestOwnListingsAndViews()を実行した直後ならAPIを追加で呼ばずに済む。
function logViewDistribution() {
  var listings = fetchEbayListings();
  var sorted = listings.slice().sort(function (a, b) { return b.views - a.views; });

  Logger.log('=== View数分布（直近' + getSettings().days + '日以内、' + listings.length + '件） ===');
  var thresholds = [500, 300, 200, 100, 50, 20, 10, 1, 0];
  thresholds.forEach(function (t) {
    var count = listings.filter(function (l) { return l.views >= t; }).length;
    Logger.log('views >= ' + t + ' : ' + count + '件');
  });

  Logger.log('=== 上位10件 ===');
  sorted.slice(0, 10).forEach(function (l) {
    Logger.log(l.views + ' views | ' + l.name + ' | ' + l.listedDate);
  });

  Logger.log('=== 現在の設定 ===');
  Logger.log(JSON.stringify(getSettings()));
}

// ===================================================================
// 【テスト用・API節約】traffic_report（View数API）を一切呼ばずに、
// 「出品取得→絞り込み→ジャンル分散選出→(必要なら)AI要約→doGet用保存」の
// 流れだけを確認するためのドライラン。View数はダミー値で代用するので、
// 選ばれる候補の中身自体は参考程度。doGet/doPostの疎通確認や承認アプリ側の
// 表示確認など、View数の正確さが関係ないテストに使う。
//
// 使い方：
//   dailyRunDryRun(false, true)  → AI要約もスキップ、doGet確認用に保存する（一番API節約）
//   dailyRunDryRun(true, true)   → AI要約は本物のClaude APIを呼ぶ（Anthropic側のクレジットは消費）
// ===================================================================
function dailyRunDryRun(useRealClaudeSummary, saveForDoGet) {
  var settings = getSettings();
  // キャッシュがあればTrading APIも呼ばない（getRecentOwnListingsCached参照）。
  // Analytics API（View数）はこの関数では一切呼ばない。
  var listings = getRecentOwnListingsCached();

  listings.forEach(function (l) {
    l.views = Math.floor(Math.random() * 1000); // ダミーView数
  });

  var pool = filterCandidatePool(listings);
  Logger.log('候補プール（ダミーView数ベース）: ' + pool.length + '件');
  var candidates = selectCandidatesByGenreRoundRobin(pool, settings.count);

  candidates.forEach(function (c) {
    if (useRealClaudeSummary) {
      var details = fetchItemDetails(c.itemId);
      c.description = details.description;
      if (details.categoryName) c.categoryName = details.categoryName; // 数値IDより見やすい正式名に差し替え
      if (details.pictureUrl) c.imageUrl = details.pictureUrl; // 一覧取得時の小さいサムネイルをフルサイズ画像に差し替え
      // 出品URLの短縮（shortenUrl）は2026-09-05に「eBayへのリンクは短縮しないでほしい」との
      // 要望を受けて廃止した。関数自体は将来また必要になった場合のために残してある。
      var material = summarizeWithClaude(c.description, c.name, c.categoryName);
      c.hook = material.hook;
      c.recommendPoint = material.recommendPoint;
      c.hashtags = material.hashtags;
    } else {
      c.description = '(ドライラン: 説明文取得スキップ)';
      c.hook = '(ドライラン) ' + c.name;
      c.recommendPoint = '(ドライラン: AI要約スキップ) ' + c.name;
      c.hashtags = ['#DryRun'];
      // カテゴリ名もここでは取りに行かない（categoryNameは数値IDのまま）。
      // 呼び出しゼロを優先するドライランなので、これはこれで正しい挙動。
    }
    Logger.log(c.itemId + ' | ' + c.name + ' | views(dummy)=' + c.views + ' | ' + c.categoryName);
  });

  if (saveForDoGet) {
    saveTodayCandidates(candidates);
    Logger.log('doGet確認用にTODAY_CANDIDATESへ保存しました');
  }
  return candidates;
}
