/**
 * 舊 log 的影廳口語簡稱 → 影視局影城名冊（.data/venues.json，2025 年）的統一編號。
 *
 * **這是人工對照表，不是演算法。** 15 個相異簡稱與 107 家官方名稱之間
 * 零個完全相同，而子字串比對會出災難性的錯：「林口威秀」的子字串
 * 「威秀」會配到「台北京站威秀影城」，正解卻是「林口MITSUI OUTLET
 * PARK威秀影城」。簡稱只有 15 個，逐筆查證比任何模糊比對都便宜且正確。
 *
 * 每一筆的 `reason` 寫的是判定依據，不是描述。日後名冊更新時，
 * 要能只讀這一欄就判斷該筆是否仍然成立。
 *
 * 查無對應者一律 `venueId: null` 並附 `question`，由人決定，不得先猜一個填著。
 */

export interface VenueAlias {
  /** 舊 log `theater` 欄的原字串。逐字比對，不做正規化或模糊比對。 */
  alias: string
  /** venue.id（統一編號）。無法對應時為 null。 */
  venueId: string | null
  /** 名冊上的官方名稱。venueId 為 null 時填該影城的通稱，供人工判讀。 */
  officialName: string
  /** 這筆紀錄在舊 log 出現幾次，供評估影響範圍。 */
  count: number
  /** 判定依據。 */
  reason: string
  /** 需要 David 裁決的問題。已確定者不填。 */
  question?: string
  /**
   * 名冊查無時，`--unmapped-venue=ugc` 會照這份資料建 venue。
   *
   * `selectable: false` 是重點：這些地方真的去過，紀錄必須留著，
   * 但已拆除的戲院與海外影城**不可以出現在新增紀錄的選單**
   * （見 supabase/migrations/0002_venue_selectable.sql）。
   */
  seed?: {
    name: string
    status: 'active' | 'closed'
    /** 歇業日；仍營業者為 null。 */
    closedAt: string | null
    city: string
    selectable: boolean
  }
}

export const VENUE_ALIASES: VenueAlias[] = [
  {
    alias: '林口威秀',
    venueId: '24808911',
    officialName: '林口MITSUI OUTLET PARK威秀影城',
    count: 115,
    reason:
      '名冊中位於林口的威秀只有這一家（威秀影城股份有限公司新北林口分公司，新北市）。'
      + '注意子字串比對在此必錯——「威秀」會先配到台北京站威秀影城。',
  },
  {
    alias: '信義威秀',
    venueId: '16431011',
    officialName: '台北信義威秀影城',
    count: 14,
    reason: '名冊中唯一的信義威秀（威秀影城股份有限公司信義分公司）。',
  },
  {
    alias: '京站威秀',
    venueId: '28984678',
    officialName: '台北京站威秀影城',
    count: 10,
    reason: '名冊中唯一的京站威秀（威秀影城股份有限公司京站分公司，台北車站京站時尚廣場）。',
  },
  {
    alias: '大直美麗華',
    venueId: '16604391',
    officialName: '美麗華大直影城',
    count: 8,
    reason:
      '大直有兩家名字相近的影城：「美麗華大直影城」（美麗華娛樂，16604391）與'
      + '「美麗新大直皇家影城」（美麗新娛樂，27985093）。判定為前者的依據有二：'
      + '① 字面上簡稱寫的是美麗「華」而非美麗「新」；'
      + '② 8 筆紀錄有 6 筆是 IMAX 場次（俠盜一號、你的名字、天氣之子、天能、'
      + '無限列車篇、捍衛戰士:獨行俠），而 IMAX 廳在美麗華大直影城——'
      + '全台第一座、也是最大的商業 IMAX（2016 年升級雷射 IMAX）；'
      + '美麗新大直皇家影城是 8 廳 202 席的沙發餐飲影城，從未有 IMAX。',
  },
  {
    alias: '林口國賓',
    venueId: '24935022',
    officialName: '林口昕境國賓影城',
    count: 5,
    reason: '名冊中位於林口的國賓只有這一家（國賓影城股份有限公司林口分公司，昕境廣場）。',
  },
  {
    alias: '板橋威秀',
    venueId: '53019247',
    officialName: '板橋大遠百威秀影城',
    count: 3,
    reason: '名冊中位於板橋的威秀只有這一家（威秀影城股份有限公司板橋分公司，板橋大遠百）。',
  },
  {
    alias: '松仁威秀',
    venueId: '54915305',
    officialName: 'MUVIE CINEMAS威秀影城',
    count: 3,
    reason:
      '名冊上的名稱不含「松仁」，但公司名稱是「威秀影城股份有限公司松仁分公司」，'
      + '即台北市信義區松仁路的 MUVIE CINEMAS。其中一筆的版本欄是 TITAN、'
      + '備註寫「TITAN廳初體驗」，TITAN 廳正設於此館，與判定一致。',
  },
  {
    alias: '西門 in89',
    venueId: '03539102',
    officialName: 'in89豪華數位影城',
    count: 2,
    reason:
      '名冊中位於台北市的 in89 只有這一家（豪華大戲院股份有限公司，萬華區武昌街），'
      + '即西門町的 in89 豪華。其餘 in89 分館分別在豐原、高雄大立、駁二、嘉義、澎湖。',
  },
  {
    alias: '大巨蛋秀泰',
    venueId: '60792059',
    officialName: '大巨蛋秀泰影城',
    count: 1,
    reason: '名冊中唯一的大巨蛋秀泰（秀泰全球影城股份有限公司大巨蛋分公司）。',
  },
  {
    alias: '桃園青埔新光影城',
    venueId: '83715707',
    officialName: '桃園新光影城',
    count: 1,
    reason:
      '名冊上的名稱是「桃園新光影城」，但公司名稱是「新光影城股份有限公司-桃園青埔分公司」，'
      + '簡稱中的「青埔」正對應此分公司。',
  },
  {
    alias: '新竹威秀',
    venueId: '80279913',
    officialName: '新竹大遠百威秀影城',
    count: 1,
    reason:
      '新竹市有兩家威秀：大遠百館（80279913）與巨城館（80531780）。這筆是 2016/07/09 的'
      + '《少女與戰車劇場版》**4DX** 場次，而 4DX 廳 2014 年設於大遠百館（由 3 號廳改裝），'
      + '巨城館自 2012 年開幕起特殊廳只有數位 IMAX、從未設過 4DX。'
      + '2016/07/06 的同期討論串亦列出當時全台 4DX 僅信義、新竹大遠百、台南大遠百、'
      + '高雄大遠百四館；林口館的 4DX 要到 2016/07/28 才試營運。',
  },
  {
    alias: '欣欣秀泰',
    venueId: '00172689',
    officialName: '欣欣秀泰影城',
    count: 1,
    reason: '名冊中唯一的欣欣秀泰（秀泰全球影城股份有限公司晶華分公司，中山區欣欣百貨）。',
  },

  // ---------------------------------------------------------------------------
  // 以下三家不在名冊裡。名冊是 2025 年的現存影城清單，而這三家分別是
  // 已歇業的台灣影城（兩家）與海外影城（一家）。這不是「對不出來」，
  // 是「名冊本來就沒有」——處理方式需要 David 決定，不由程式猜。
  // ---------------------------------------------------------------------------
  {
    alias: '日新威秀',
    venueId: null,
    officialName: '台北日新威秀影城（已於 2020-09-08 歇業）',
    count: 2,
    reason:
      '前身為 1966 年開幕的日新大戲院（台北市萬華區武昌街二段 87 號），'
      + '2007/08/03 由威秀接手改名，2009/04/03 將 1 廳改建為數位 IMAX（626 席），'
      + '2020/09/08 結束營業、建物拆除。兩筆紀錄（2014/11 星際效應 IMAX、'
      + '2019/06 復仇者聯盟：終局之戰 IMAX 3D）都在營業期間內且與 IMAX 廳吻合。'
      + '**注意**：名冊中的「日新大戲院」（41562807）在宜蘭縣、'
      + '「日日新大戲院」（97265890）在台中市，都不是這一家，不可誤配。',
    question:
      '已歇業、不在 2025 年名冊中。要 ① 略過這 2 筆，② 建一筆 '
      + 'venue（ugc: 前綴、status=closed、closed_at=2020-09-08），還是 ③ 掛到 virtual:other？',
    seed: {
      name: '台北日新威秀影城',
      status: 'closed',
      closedAt: '2020-09-08',
      city: '台北市',
      selectable: false,
    },
  },
  {
    alias: '喜滿客京華影城',
    venueId: null,
    officialName: '喜滿客京華影城（Cinemark 京華城，已於 2019-11-30 歇業）',
    count: 2,
    reason:
      '位於京華城購物中心 B1（台北市松山區八德路四段 138 號），'
      + '隨京華城於 2019/11/30 一同結束營業，建物 2020 年拆除。'
      + '兩筆紀錄都在 2016 年，在營業期間內。'
      + 'Cinemark 在台灣目前零據點（高雄夢時代館、西門町絕色館亦已先後熄燈）。'
      + '**注意**：名冊中的「台北西門威秀影城」（00196922）是絕色影城舊址'
      + '於 2024 年由威秀接手而來，與京華城分館無關，不可拿來對應。',
    question: '同上，已歇業且不在名冊中。要略過、建 ugc: venue，還是掛 virtual:other？',
    seed: {
      name: '喜滿客京華影城',
      status: 'closed',
      closedAt: '2019-11-30',
      city: '台北市',
      selectable: false,
    },
  },
  {
    alias: 'イオンシネマ シアタス心斎橋',
    venueId: null,
    officialName: 'AEON Cinema THEATUS Shinsaibashi（日本大阪，心斎橋 PARCO 12F）',
    count: 1,
    reason:
      '日本大阪市中央區的影城，2021/03/16 開幕、至今營業中，'
      + '經營者為イオンエンターテイメント，在台灣沒有任何據點。'
      + '該筆備註寫「解鎖人生成就『在日本看電影』」「票價為 JPY 1,600」，'
      + '確認是海外觀影，不屬於台灣影城名冊的範圍。',
    question:
      '海外影城。要 ① 略過，② 建一筆 ugc: venue，還是 ③ 掛到 virtual:other'
      + '（會失去「在日本看的」這個資訊，但備註裡還留著）？',
    // status 仍是 active——這家還在正常營業。它不該進選單的理由是
    // 「不在台灣、超出 SPEC 範圍」，不是歇業。兩者用不同欄位表達。
    seed: {
      name: 'イオンシネマ シアタス心斎橋（日本大阪）',
      status: 'active',
      closedAt: null,
      city: '大阪市',
      selectable: false,
    },
  },
]

/** 待 David 裁決的簡稱。匯入報告會把這些列出來。 */
export const AMBIGUOUS_ALIASES: VenueAlias[] = VENUE_ALIASES.filter(e => e.question !== undefined)

const BY_ALIAS = new Map(VENUE_ALIASES.map(e => [e.alias, e]))

/**
 * 逐字查表。查無此簡稱時回傳 null——**不做子字串或模糊比對**。
 *
 * 上游冒出新的簡稱時，這裡回傳 null 會讓匯入把該筆列進報告等人補表，
 * 這正是我們要的行為：寧可少匯入一筆，也不要把它配到錯的影城。
 */
export function resolveVenueAlias(theater: string): VenueAlias | null {
  return BY_ALIAS.get(theater.trim()) ?? null
}
