/**
 * 3.7 / 3.8 新增逻辑的离线自测（不依赖浏览器 / 油猴）
 *
 * 做法：把 userscript 里「商店补货 → 主循环」这一段源码切出来，
 * 用一个假的运行环境（S / localStorage / document / fire / TA_* 伤害层）包起来跑，
 * 这样改逻辑时不用开游戏就能先验一遍。
 *
 *   node tests/logic.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'pokecatch-autofarm.user.js');
const source = fs.readFileSync(SRC, 'utf8');

const START = '/* ====================== 模块：商店采购';
const END = '/* ====================== 主循环';
const from = source.indexOf(START);
const to = source.indexOf(END, from);
if (from < 0 || to < 0) {
  console.error('找不到模块段落，请检查分隔注释是否还在');
  process.exit(1);
}
const moduleCode = source.slice(from, to);

/* ---------------- 假环境 ---------------- */

function makeEnv(opts = {}) {
  const store = new Map(Object.entries(opts.ls || {}));
  const fired = [];
  const logs = [];
  const push = [];
  const downloads = [];

  const S = {
    cfg: Object.assign({
      autoShop: true,
      shopKeepBerries: 3,
      shopKeepCandy: 0,
      shopMoneyFloor: 1000,
      shopDailyCap: 0,
      shopEveryMin: 10,
      berryFamilies: { shiny: true, dex: true, rare: true, capture: true, xp: true, money: true },
      daycareWatch: true,
      ledger: true,
      dailyReport: false,
      dailyReportHour: 0,
      // 战斗辅助
      battlePanel: true,
      battleSwitchSmart: false,
      battleSwitchWin: 25,
      battleAutoOrder: false,
      battleStats: true,
      battleWarnStreak: 3,
      autoSwitch: false,
      switchAtHp: 30,
    }, opts.cfg || {}),
    keepAliveOn: false,
    save: opts.save || null,
    // 战斗辅助要用到的运行时状态
    battle: null,
    btFight: null,
    btWarnAt: 0,
    deaths: 0,
    switchAt: 0,
    feeding: false,
  };

  const BERRY_BUFFS = {
    'starf-berry': { family: 'shiny', mult: 2, rank: 3, label: '闪光' },
    'enigma-berry': { family: 'dex', mult: 3, rank: 3, label: '图鉴' },
    'nanab-berry': { family: 'rare', mult: 2, rank: 3, label: '稀有' },
    'golden-razz-berry': { family: 'capture', mult: 1.5, rank: 2, label: '捕获' },
    'razz-berry': { family: 'capture', mult: 1.25, rank: 1, label: '捕获' },
    'pinap-berry': { family: 'xp', mult: 1.25, rank: 1, label: '经验' },
    'lansat-berry': { family: 'money', mult: 1.25, rank: 1, label: '金钱' },
  };

  const env = {
    S,
    BERRY_BUFFS,
    VERSION: 'test',
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
    fmt: (n) => String(Math.round(n || 0)),
    esc: (s) => String(s == null ? '' : s),
    now: () => (env.clock ? env.clock : Date.now()),
    lsGet: (k) => (store.has(k) ? store.get(k) : null),
    lsSet: (k, v) => { store.set(k, v); return true; },
    safeParse: (raw, fb) => { try { const v = JSON.parse(raw); return v == null ? fb : v; } catch { return fb; } },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    fire: (el) => { fired.push(el); return true; },
    log: (kind, msg) => { logs.push(`[${kind}] ${msg}`); },
    notify: () => {},
    pushSend: (kind, title, body) => { push.push({ kind, title, body }); return Promise.resolve({ ok: true }); },
    downloadText: (name, text) => { downloads.push({ name, text }); return true; },
    scheduleHud: () => {},
    userBusy: () => false,
    isRealHidden: () => false,
    readSave: () => env.S.save,
    setTimeout: (fn) => { env.timers.push(fn); return 0; },
    // 战斗辅助要用的伤害层（用可预测的假实现，专测 3.8 的判定与统计逻辑）
    TA_DEX: new Proxy({}, { get: () => ['normal'] }),
    taStats: () => ({ hp: 100, atk: 50, def: 50, spa: 50, spd: 50, spe: 50 }),
    taMaxHp: (mon) => 100 + (mon.level || 1) * 2,
    taBestMove: () => ({ key: 'tackle', type: 'normal', phys: true, power: 40, eff: 2, stab: 1, acc: 1, score: 80 }),
    taDamage: () => 40,
    taEvaluate: () => ({ score: 50 }),
    taEnemyPool: () => [],
    taMonName: (mon) => `#${mon.id}`,
  };
  env.clock = 0;
  env.timers = [];
  env.fired = fired;
  env.logs = logs;
  env.push = push;
  env.downloads = downloads;
  env.store = store;

  const names = Object.keys(env);
  const factory = new Function(...names, `${moduleCode}
    return { shopPlan, autoShop, settleShop, shopFindRow, shopDiag, ledgerTick, ledgerAdd, ledgerToday, ledgerData,
             ledgerCsv, dayKey, dexGap, dexGapText, daycareState, daycareTick, dailyReportText, NEW_DAY,
             btPct, btSpriteId, btLevel, btForecast, btBenchCandidates, btZone, btData, btRecord,
             btZoneStats, battleTick, btStreakWarn, btLeadPick, smartSwitch, btHudHtml,
             lvParseNum, lvPlanBuy, lvOwnedXp, lvCoverPlan, lvXpNeed, lvCounts, lvBreakdown, lvXpMap, lvPlanText, lvBurstCount };`);
  env.api = factory(...names.map((n) => env[n]));
  return env;
}

/* ---------------- 断言 ---------------- */

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; return; }
  fails.push(name + (extra ? ' → ' + extra : ''));
}
function eq(a, b, name) { ok(a === b, name, `${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

/* ---------------- 1. 采购清单（这店是固定货架：只有经验糖、进化石、一次性进化道具） ---------------- */

{
  /* 金钱到下限就什么都不买 */
  const poor = makeEnv({ save: { money: 500, items: {} }, cfg: { shopKeepCandy: 3, shopMoneyFloor: 1000 } });
  const pp = poor.api.shopPlan(poor.S.save, poor.S.cfg);
  eq(pp.ok, false, '金钱到下限就不采购');
  ok(/下限/.test(pp.reason), '给出下限原因');

  /* 什么都没启用 → 明说不买 */
  const idle = makeEnv({ save: { money: 200000, items: {} }, cfg: { shopKeepCandy: 0 } });
  eq(idle.api.shopPlan(idle.S.save, idle.S.cfg).ok, false, '没有启用采购项时不瞎买');

  /* 预算够 → 候选按「每 ₽ 经验」从高到低排，最前一个是 big */
  const rich = makeEnv({ save: { money: 200000, items: {} }, cfg: { shopKeepCandy: 3, shopMoneyFloor: 0, shopDailyCap: 0 } });
  const p1 = rich.api.shopPlan(rich.S.save, rich.S.cfg);
  eq(p1.ok, true, '预算够就能采购');
  eq(p1.picks.map((p) => p.id).join(','), 'exp-candy-big,exp-candy-xl,exp-candy-m,exp-candy-s', '四档按性价比排序');

  /* 预算只够小档 → 买不起的档不列进来 */
  const mid = makeEnv({ save: { money: 2000, items: {} }, cfg: { shopKeepCandy: 1, shopMoneyFloor: 0 } });
  eq(mid.api.shopPlan(mid.S.save, mid.S.cfg).picks.map((p) => p.id).join(','), 'exp-candy-s', '只留买得起的档');

  /* 已经买够的档跳过 */
  const stocked = makeEnv({ save: { money: 300000, items: { 'exp-candy-big': 3, 'exp-candy-xl': 3 } }, cfg: { shopKeepCandy: 3, shopMoneyFloor: 0 } });
  eq(stocked.api.shopPlan(stocked.S.save, stocked.S.cfg).picks.map((p) => p.id).join(','), 'exp-candy-m,exp-candy-s', '够数的档不再买');

  /* 日上限：今天已经花满就不再买 */
  const capped = makeEnv({ save: { money: 500000, items: {} }, cfg: { shopKeepCandy: 1, shopMoneyFloor: 0, shopDailyCap: 50000 } });
  capped.clock = Date.parse('2026-11-16T10:00:00+08:00');
  capped.api.ledgerTick();
  capped.api.ledgerAdd({ spent: 50000 });
  const pc = capped.api.shopPlan(capped.S.save, capped.S.cfg);
  eq(pc.ok, false, '日上限花满就停手');
  ok(/上限/.test(pc.reason), '给出上限原因');

  /* 一次性进化道具：买过的不再买 */
  const once = makeEnv({ save: { money: 900000, items: {} }, cfg: { shopBuyOneOff: true, shopKeepCandy: 0, shopMoneyFloor: 0 } });
  const p2 = once.api.shopPlan(once.S.save, once.S.cfg);
  eq(p2.ok, true, '一次性道具可以采购');
  eq(p2.picks[0].id, 'soothe-bell', '按清单顺序先买安抚之铃');
  eq(p2.picks[0].kind, 'once', '标记为一次性道具');
  once.S.save = { money: 900000, items: { 'soothe-bell': 1 } };
  eq(once.api.shopPlan(once.S.save, once.S.cfg).picks[0].id, 'kings-rock', '已经有的跳过');

  /* 买不起 50 万时不要列一次性道具 */
  const cheap = makeEnv({ save: { money: 300000, items: {} }, cfg: { shopBuyOneOff: true, shopKeepCandy: 0, shopMoneyFloor: 0 } });
  eq(cheap.api.shopPlan(cheap.S.save, cheap.S.cfg).ok, false, '钱不够就不买 50 万的进化道具');
}

/* ---------------- 2. autoShop 的防护与点击顺序 ---------------- */

function mockShopDom(rows) {
  const buyBtn = { tag: 'buy', disabled: false };
  const seg1 = { tag: 'seg1', classList: { contains: () => false } };
  const rowById = new Map(rows.map((r) => [r.id, {
    tag: r.id,
    dataset: { id: r.id },
    classList: { contains: (c) => (r.locked ? c === 'locked' : false) },
    querySelector: (sel) => (String(sel).includes('button.buy') ? (r.locked ? null : buyBtn) : null),
    querySelectorAll: (sel) => (String(sel).includes('.seg button') ? [seg1] : []),
  }]));
  return {
    buyBtn,
    seg1,
    document: {
      querySelector: (sel) => {
        if (sel === '#shop-grid') return {};
        if (sel === '[data-go="shop"]') return null;
        if (sel === '#screen-shop [data-sh-mode="buy"]') return { classList: { contains: () => true } };
        const m = /data-id="(.+)"\]/.exec(String(sel));
        if (m) return rowById.get(m[1]) || null;
        return null;
      },
      querySelectorAll: () => [],
    },
  };
}

function rebuild(env, body) {
  const names = Object.keys(env).filter((k) => k !== 'api');
  return new Function(...names, `${moduleCode}\n return ${body};`)(...names.map((k) => env[k]));
}

{
  /* 最划算的 big 有货就买 big */
  const save = { money: 300000, items: {} };
  const env = makeEnv({ save, cfg: { shopKeepCandy: 3, shopMoneyFloor: 1000, shopDailyCap: 0 } });
  const dom = mockShopDom([{ id: 'exp-candy-big' }, { id: 'exp-candy-s' }]);
  env.document = dom.document;
  env.api = rebuild(env, '{ autoShop }');
  env.clock = 1000;
  env.api.autoShop(true);
  ok(env.fired.includes(dom.buyBtn), '点了购买按钮');
  ok(env.fired.includes(dom.seg1), '没选数量档时先点 ×1');
  ok(!!env.S.shopPending, '记下待结算的订单');

  /* 余额保护：钱低于下限一颗都不买 */
  const poor = makeEnv({ save: { money: 500, items: {} }, cfg: { shopKeepCandy: 3, shopMoneyFloor: 1000 } });
  const pdom = mockShopDom([{ id: 'exp-candy-s' }]);
  poor.document = pdom.document;
  poor.api = rebuild(poor, '{ autoShop }');
  poor.clock = 1000;
  poor.api.autoShop(true);
  eq(poor.fired.length, 0, '金钱低于下限一颗都不买');

  /* 最划算的档锁着 → 顺延到下一档，而不是原地跳过 */
  const lock = makeEnv({ save: { money: 300000, items: {} }, cfg: { shopKeepCandy: 3, shopMoneyFloor: 0, shopDailyCap: 0 } });
  const ldom = mockShopDom([{ id: 'exp-candy-big', locked: true }, { id: 'exp-candy-xl' }]);
  lock.document = ldom.document;
  lock.api = rebuild(lock, '{ autoShop }');
  lock.clock = 1000;
  lock.api.autoShop(true);
  ok(lock.fired.includes(ldom.buyBtn), '锁档时换下一档并成功下单');
  eq((lock.S.shopPending || {}).id, 'exp-candy-xl', '实际下单的是 xl');

  /* 货架上什么都没有 → 不点，只在日志里说一次原因 */
  const miss = makeEnv({ save: { money: 300000, items: {} }, cfg: { shopKeepCandy: 3, shopMoneyFloor: 0 } });
  miss.document = mockShopDom([]).document;
  miss.api = rebuild(miss, '{ autoShop }');
  miss.clock = 1000;
  miss.api.autoShop(true);
  eq(miss.fired.length, 0, '货架没货就不点');
  ok(miss.logs.some((l) => l.includes('没有能下单的商品')), '日志说明为什么没买');
}

/* ---------------- 3. 账本 ---------------- */

{
  const env = makeEnv({ save: { money: 1000, stats: { caught: 10, battles: 20, evolutions: 1, hatched: 0 } } });
  env.clock = Date.parse('2026-11-15T10:00:00+08:00');
  env.api.ledgerTick();                                   // 第一次只建基线

  env.clock += 5000;
  env.S.save = { money: 1600, stats: { caught: 13, battles: 25, evolutions: 2, hatched: 1 } };
  env.api.ledgerTick();

  const day = env.api.ledgerToday();
  eq(day.money, 600, '收入按金钱正增量累计');
  eq(day.caught, 3, '捕获增量');
  eq(day.battles, 5, '战斗增量');
  eq(day.evolutions, 1, '进化增量');
  eq(day.hatched, 1, '孵化增量');

  env.clock += 5000;
  env.S.save = { money: 100, stats: { caught: 13, battles: 25, evolutions: 2, hatched: 1 } };
  env.api.ledgerTick();
  eq(env.api.ledgerToday().spent, 1500, '金钱减少记成支出');
  eq(env.api.ledgerToday().money, 600, '支出不冲抵收入');

  /* 跨天：昨天的记录还在 */
  env.clock = Date.parse('2026-11-16T09:00:00+08:00');
  env.api.ledgerTick();
  const all = env.api.ledgerData().days;
  ok(all['2026-11-15'] && all['2026-11-15'].money === 600, '跨天后昨天的账本保留');
  eq(env.api.ledgerToday().money, 0, '新的一天从 0 开始');

  /* CSV */
  env.api.ledgerCsv();
  const csv = env.downloads[0];
  ok(!!csv, '导出了 CSV');
  ok(csv.text.includes('日期,收入'), 'CSV 有表头');
  ok(csv.text.includes('2026-11-15'), 'CSV 有昨日数据');
  ok(csv.text.charCodeAt(0) === 0xfeff, 'CSV 带 BOM（Excel 中文不乱码）');
}

/* ---------------- 4. 图鉴缺口 ---------------- */

{
  const env = makeEnv();
  const dex = {};
  for (let i = 1; i <= 151; i++) dex[i] = 1;      // 关都满
  for (let i = 152; i <= 200; i++) dex[i] = 1;    // 城都 49 只
  dex['25:form'] = 1;                              // 带形态后缀的键不能重复计数
  const gap = env.api.dexGap({ dex });
  const kanto = gap.gens.find((g) => g.key === 'kanto');
  const johto = gap.gens.find((g) => g.key === 'johto');
  eq(gap.total, 200, '重复形态不重复计数');
  eq(kanto.pct, 100, '关都 100%');
  eq(johto.left, 51, '城都还差 51 只');
  eq(gap.current.key, 'johto', '当前地区取已开最多的那一代');
  ok(env.api.dexGapText(gap).includes('城都'), '缺口文案带地区名');
  ok(env.api.dexGapText({ gens: [], current: { name: '?', left: 0, have: 0, need: 0 } }).includes('还没有图鉴数据'),
      '空图鉴有兜底文案');
}

/* ---------------- 5. 培育屋 ---------------- */

{
  const env = makeEnv();
  const st = env.api.daycareState({
    pension: { mons: [{ mon: { shiny: true } }, { mon: { shiny: true } }], eggs: [{ uid: 1 }, { uid: 2 }] },
  });
  eq(st.slots, 2, '两只亲代');
  eq(st.eggs, 2, '两颗蛋');
  eq(st.shinyParents, 2, '闪光亲代计数');
  ok(st.shinyNote.includes('1/10'), '闪光配对提示');

  /* 新蛋提醒只触发一次 */
  env.S.save = { pension: { mons: [{ mon: {} }], eggs: [] } };
  env.api.daycareTick();                    // 建基线
  env.S.save = { pension: { mons: [{ mon: {} }], eggs: [{ uid: 9 }] } };
  env.clock += 1000;
  env.api.daycareTick();
  eq(env.logs.filter((l) => l.includes('🥚')).length, 1, '新蛋只播报一次');
  env.api.daycareTick();
  eq(env.logs.filter((l) => l.includes('🥚')).length, 1, '蛋数没变不再播报');
}

/* ---------------- 6. 每日战报 ---------------- */

{
  const env = makeEnv({ cfg: { dailyReport: true, dailyReportHour: 0 } });
  env.clock = Date.parse('2026-11-15T09:00:00+08:00');
  env.api.ledgerAdd({ money: 1234, spent: 500, caught: 20, hatched: 2, evolutions: 3, ms: 3600000 }, Date.parse('2026-11-14T12:00:00+08:00'));
  env.S.save = { dex: { 1: 1, 2: 1 } };
  const text = env.api.dailyReportText();
  ok(text.includes('2026-11-14'), '战报写的是昨天');
  ok(text.includes('1234'), '战报带收入');
  ok(text.includes('图鉴'), '战报带图鉴缺口');
}

/* ---------------- 7. 战斗遥测与换人判定 ---------------- */

{
  const env = makeEnv();
  const A = env.api;

  /* 血条宽度：只认百分比，px 一律当满血（否则每只都被当残血，天天抢操作） */
  eq(A.btPct({ style: { width: '55%' } }), 55, "btPct 读百分比");
  eq(A.btPct({ style: { width: '0px' } }), 100, 'px 宽度视为满血');
  eq(A.btPct({ style: { width: '' } }), 100, '读不到宽度视为满血');
  eq(A.btPct(null), 100, '元素不存在也不炸');

  /* 图鉴号从精灵地址反推 */
  eq(A.btSpriteId({ src: 'assets/pokemon/25.png' }), 25, '普通精灵');
  eq(A.btSpriteId({ src: 'https://x/assets/pokemon/shiny/150.png' }), 150, '闪光精灵');
  eq(A.btSpriteId({ src: 'assets/pokemon/egg.png' }), 0, '非编号地址返回 0');

  eq(A.btLevel('Nv.23'), 23, '等级文案 Nv.23');
  eq(A.btLevel(''), 1, '没有等级时按 1 级');

  /* 对位预测：ttk/ttd 与胜率的相关性（伤害层用 40 固定伤害的假实现） */
  const me = { id: 1, level: 50, hpPct: 100 };
  const foe = { id: 2, level: 50, hpPct: 100 };
  const f1 = A.btForecast(me, foe);
  ok(f1 && f1.ttk >= 1 && f1.ttd >= 1, 'btForecast 给出回合数');
  ok(f1.winPct >= 55 && f1.winPct <= 99, '满血对满血不会给出劣势胜率');
  const f2 = A.btForecast(me, { ...foe, hpPct: 20 });
  ok(f2.winPct > f1.winPct, '残血敌人更容易赢');
  ok(f2.ttk <= f1.ttk, '残血敌人需要更少回合');
  const f3 = A.btForecast({ ...me, hpPct: 10 }, foe);
  ok(f3.winPct < 55, '自己残血时胜率掉到 55 以下');
  eq(A.btForecast({ id: 1, level: 5 }, null), null, '没有敌人就返回 null');
}

/* ---------------- 8. 替补挑选 ---------------- */

{
  const env = makeEnv();
  const api = env.api;
  const team = [
    { uid: 1, id: 1, level: 50 },
    { uid: 2, id: 2, level: 50 },
    { uid: 3, id: 3, level: 50 },
    { uid: 4, id: 4, level: 50 },   // 血量见底，不该被选中
  ];
  const hp = { 1: 40, 2: 100, 3: 80, 4: 5 };
  const state = { active: true, me: { uid: 1, id: 1, level: 50, hpPct: 40 }, foe: { id: 2, level: 50, hpPct: 100 } };
  const cands = api.btBenchCandidates(state, team, (u) => hp[u]);
  ok(!cands.some((c) => c.uid === 1), '不含在场的那只');
  ok(!cands.some((c) => c.uid === 4), '残血替补被排除');
  eq(cands.length, 2, '只剩两只健康的');
  ok(cands[0].winPct >= cands[1].winPct, '按胜率降序');
  eq(api.btBenchCandidates({ foe: null }, team, () => 100).length, 0, '没有敌人时没有候选');
}

/* ---------------- 9. 区域战绩 / 连败提醒 ---------------- */

{
  const env = makeEnv({ cfg: { battleStats: true, battleWarnStreak: 3 } });
  const api = env.api;
  const save = { adv: { chapter: 0, node: 2, nodes: [{ name: '一号路' }, { name: '二号路' }, { name: '常磐森林' }] } };
  const zone = api.btZone(save);
  eq(zone.name, '常磐森林', '区域名取 adv.nodes[node].name');
  eq(zone.key, '0:2', '区域键 = 章节:节点');

  api.btRecord(true, { key: zone.key, name: zone.name, hpLoss: 20, ms: 3000 });
  api.btRecord(true, { key: zone.key, name: zone.name, hpLoss: 40, ms: 5000 });
  api.btRecord(false, { key: zone.key, name: zone.name, hpLoss: 100, ms: 4000 });
  const st = api.btZoneStats(save);
  eq(st.n, 3, '三场战斗');
  eq(st.win, 2, '两胜');
  eq(st.loss, 1, '一负');
  eq(st.rate, 67, '胜率四舍五入');
  eq(st.avgHpLoss, 53, '平均掉血 (20+40+100)/3');

  /* 连败 3 场后提醒；10 分钟内不重复 */
  api.btRecord(false, { key: zone.key, name: zone.name, hpLoss: 100, ms: 4000 });
  api.btRecord(false, { key: zone.key, name: zone.name, hpLoss: 100, ms: 4000 });
  env.clock = 5000;
  api.btStreakWarn();
  eq(env.logs.filter((l) => l.includes('连败')).length, 1, '连败达阈值提醒一次');
  eq(env.push.filter((p) => p.title === '连败提醒').length, 1, '连败也走手机推送');
  env.clock = 60000;
  api.btStreakWarn();
  eq(env.logs.filter((l) => l.includes('连败')).length, 1, '10 分钟内不重复提醒');
  env.clock = 700000;
  api.btStreakWarn();
  eq(env.logs.filter((l) => l.includes('连败')).length, 2, '过了 10 分钟可以再提醒');

  /* 赢一场就清零连败 */
  api.btRecord(true, { key: zone.key, name: zone.name, hpLoss: 0, ms: 2000 });
  eq(api.btData().streak, 0, '赢了就清空连败计数');

  /* 关掉 battleStats 就不再记账 */
  const off = makeEnv({ cfg: { battleStats: false } });
  off.api.btRecord(true, { key: 'x', name: 'y' });
  ok(!off.api.btData().zones.x, '关了统计就不写 localStorage');
}

/* ---------------- 10. 战斗结束结算（battleTick） ---------------- */

{
  const env = makeEnv({ cfg: { battleStats: true, battleWarnStreak: 0 } });
  const api = env.api;
  env.S.save = { adv: { chapter: 3, node: 1, nodes: [null, { name: '雪峰' }] } };
  env.clock = 10000;

  /* 假环境没有 #arena，battleProbe 永远 inactive；手工摆一个进行中的战斗 */
  env.S.battle = { active: true, me: { uid: 1, id: 1, hpPct: 90 }, foe: { id: 2, hpPct: 10 } };
  env.S.btFight = { at: 5000, hp0: 90, hpLast: 40, zone: '3:1', zoneName: '雪峰', deaths0: env.S.deaths };
  env.S.deaths = 0;
  api.battleTick();
  const st = api.btZoneStats(env.S.save);
  eq(st.n, 1, '战斗结束落一条战绩');
  eq(st.win, 1, '没掉死亡就算赢');
  eq(st.avgHpLoss, 50, '掉血 = 开战前 - 最后一帧');

  /* 死亡了就算负 */
  env.clock = 30000;
  env.S.battle = { active: true, me: { uid: 1, id: 1, hpPct: 90 }, foe: { id: 2, hpPct: 10 } };
  env.S.btFight = { at: 20000, hp0: 90, hpLast: 0, zone: '3:1', zoneName: '雪峰', deaths0: 0 };
  env.S.deaths = 1;
  api.battleTick();
  eq(api.btZoneStats(env.S.save).loss, 1, '死亡记成负');

  /* 太短的战斗（<1.2 秒）算场景抖动，不记账 */
  env.clock = 40000;
  env.S.battle = { active: true, me: { uid: 1, id: 1, hpPct: 90 }, foe: { id: 2, hpPct: 10 } };
  env.S.btFight = { at: 39500, hp0: 90, hpLast: 90, zone: '3:1', zoneName: '雪峰', deaths0: 1 };
  api.battleTick();
  eq(api.btZoneStats(env.S.save).n, 2, '抖动不产生新战绩');
}

/* ---------------- 11. 首发建议 ---------------- */

{
  const env = makeEnv({ save: { team: [{ uid: 1, id: 1, level: 20 }, { uid: 2, id: 2, level: 20 }, { uid: 3, id: 3, level: 20 }] } });
  env.taEnemyPool = () => [{ id: 9, level: 20, w: 1 }];
  env.taEvaluate = (mon) => ({ score: mon.id === 2 ? 80 : 50 });
  const names = Object.keys(env).filter((k) => k !== 'api');
  env.api = new Function(...names, `${moduleCode}
    return { btLeadPick };`)(...names.map((k) => env[k]));

  const pick = env.api.btLeadPick(env.S.save);
  ok(!!pick, '有敌人池时给出首发建议');
  eq(pick.uid, 2, '选出评分最高的那只');
  eq(pick.isFirst, false, '当前队首不是它');
  ok(pick.score === 80, '带回评分');

  /* 敌人池为空 / 队伍不足两只 → 不瞎推荐 */
  env.taEnemyPool = () => [];
  const empty = new Function(...names, `${moduleCode}
    return { btLeadPick };`)(...names.map((k) => env[k]));
  eq(empty.btLeadPick(env.S.save), null, '没有敌人池就不推荐');
  eq(env.api.btLeadPick({ team: [{ uid: 1, id: 1 }] }), null, '只有一只也不用排');
}

/* ---------------- 12. 对位卡渲染 ---------------- */

{
  const env = makeEnv({ save: { adv: { chapter: 0, node: 0, nodes: [{ name: '一号路' }] } } });
  eq(env.api.btHudHtml(), '', '没有战斗时不渲染对位卡');

  env.S.battle = { active: true, me: { uid: 1, id: 1, level: 20, hpPct: 80 }, foe: { id: 2, level: 20, hpPct: 35 } };
  const html = env.api.btHudHtml();
  ok(html.includes('对位'), '对位卡有「对位」行');
  ok(html.includes('胜率'), '对位卡有胜率行');
  ok(html.includes('#1') && html.includes('#2'), '对位卡带双方名字');
  ok(html.includes('80%') && html.includes('35%'), '对位卡带双方血量');

  /* 赢了 3 场之后应出现本区战绩行 */
  env.api.btRecord(true, { key: '0:0', name: '一号路', hpLoss: 10, ms: 2000 });
  const html2 = env.api.btHudHtml();
  ok(html2.includes('本区战绩'), '有战绩时显示本区战绩');
  ok(html2.includes('1 战 1 胜'), '战绩数字正确');
}

/* ---------------- 13. 升到下一级（读经验条 / 买糖估价） ---------------- */

{
  const env = makeEnv({ save: { money: 100000, items: { 'exp-candy-s': 2, 'exp-candy-xl': 1 } } });
  const api = env.api;

  /* 数字解析：中文界面「经验值 1,200 / 34,000」这类文案要能读 */
  eq(api.lvParseNum('1,200'), 1200, '带千分位');
  eq(api.lvParseNum('34 000'), 34000, '带空格分隔');
  eq(api.lvParseNum('3.5k'), 3500, 'k 后缀');
  eq(api.lvParseNum('1.2M'), 1200000, 'M 后缀');
  eq(api.lvParseNum('经验值 1,200 / 34,000'), 1200, '只取第一个数');
  eq(api.lvParseNum('没有数字'), null, '没有数字返回 null');

  /* 经验条：XP a / b → 还差多少 */
  const modal = (txt) => ({ querySelector: (sel) => (sel.includes('xpbar') ? { textContent: txt } : null) });
  const need1 = api.lvXpNeed(modal('经验值 1,200 / 34,000'));
  eq(need1.cur, 1200, '当前经验');
  eq(need1.max, 34000, '升级所需');
  eq(need1.need, 32800, '还差的经验');
  eq(api.lvXpNeed(modal('乱码文案')), null, '读不到就返回 null，不瞎猜');

  /* 自己有多少糖 = 多少经验 */
  const counts = api.lvCounts(env.S.save);
  eq(counts['exp-candy-s'], 2, '小糖 2 颗');
  eq(counts['exp-candy-m'], 0, '没有中糖');
  eq(api.lvOwnedXp(counts), 2 * 1000 + 250000, '总经验 = 2×1000 + 1×250000');

  /* 「先算再动手」：只列出刚好够用的糖，多余的糖不动 */
  const plan1 = api.lvCoverPlan(counts, 2000);
  eq(plan1.ids.length, 2, '差 2,000 经验只吃 2 颗小糖');
  eq(plan1.ids[0], 'exp-candy-s', '先吃小糖');
  eq(plan1.enough, true, '够用');
  eq(api.lvCoverPlan(counts, 2500).ids[2], 'exp-candy-xl', '小糖吃完仍不够才轮到 XL');

  const plan2 = api.lvCoverPlan(counts, 300000);
  eq(plan2.enough, false, '自有糖不够时如实返回不够');
  eq(plan2.xp, 252000, '够不够是按总经验算的');

  const all = api.lvCoverPlan(counts, Infinity);
  eq(all.ids.length, 3, '要「全吃」时返回全部糖');
  eq(api.lvCoverPlan(counts, 0).ids.length, 0, '不需要经验就不吃');

  /* 关键回归：够的时候不该问价，不够的时候必须在吃之前就知道 */
  const owned = api.lvOwnedXp(counts);
  eq(owned >= 32800, true, '32800 经验缺口下自有糖够 → 走「直接吃」分支');
  eq(owned >= 300000, false, '30 万经验缺口下自有糖不够 → 必须先问再吃');

  /* 档位经验随进度缩放：读弹窗按钮的 +xxx，读不到才用常量 */
  const fakeModal = (labels) => ({
    querySelector: () => null,
    querySelectorAll: () => labels.map((t) => ({ querySelector: () => ({ textContent: t }) })),
  });
  const scaled = api.lvXpMap(fakeModal(['+600', '+9.0k', '+150k', '+600k']));
  eq(scaled['exp-candy-s'], 600, '小糖 600');
  eq(scaled['exp-candy-m'], 9000, '中糖 9,000');
  eq(scaled['exp-candy-xl'], 150000, 'XL 150,000');
  eq(scaled['exp-candy-big'], 600000, 'MAX 600,000');
  const fallback = api.lvXpMap(fakeModal([]));
  eq(fallback['exp-candy-xl'], 250000, '读不到标签就退回源码常量');

  /* 拆分买法：大档整除 → 余数给下一档 → 零头补一颗最小档 */
  const bd1 = api.lvBreakdown(159000, scaled);
  eq(bd1.parts.length, 2, '159,000 拆成两档');
  eq(bd1.parts[0].id, 'exp-candy-xl', '先 1 颗 XL');
  eq(bd1.parts[0].qty, 1, 'XL 一颗');
  eq(bd1.parts[1].id, 'exp-candy-m', '余下 9,000 用 M 补');
  eq(bd1.parts[1].qty, 1, 'M 一颗');
  eq(bd1.totalXp, 159000, '合计正好 159,000');
  eq(bd1.overshoot, 0, '不浪费');
  eq(bd1.cost, 48000 + 7200, '花费 55,200（不是买 2 颗 XL 的 96,000）');

  const bd2 = api.lvBreakdown(159100, scaled);
  const small2 = bd2.parts.find((p) => p.id === 'exp-candy-s');
  eq(small2.qty, 1, '余 100 经验不足最小档 → 补 1 颗小糖');
  eq(bd2.overshoot, 500, '只多出 500 经验');

  const bd3 = api.lvBreakdown(1250000, scaled);
  eq(bd3.parts[0].id, 'exp-candy-big', '百万级先用 MAX');
  eq(bd3.parts[0].qty, 2, '2 颗 MAX = 1,200,000');
  eq(bd3.parts[1].id, 'exp-candy-m', '余 50,000 先给 M（150k 的 XL 装不下）');
  eq(bd3.parts[1].qty, 5, '5 颗 M = 45,000');
  eq(bd3.parts[2].qty, 9, '余 5,000 用 9 颗小糖（8 颗不够，补 1 颗）');

  /* 预算边界 */
  const p1 = api.lvPlanBuy(250000, null, 100000, 20000);
  eq(p1.ok, true, '可以买');
  eq(p1.cost, 48000, '25 万经验 = 1 颗 XL（48,000）');
  eq(p1.affordable, true, '预算内');

  const p2 = api.lvPlanBuy(20000, null, 100000, 20000);
  eq(p2.cost, 13200, '2 万经验 = 1 M + 5 S（13,200），比 2 颗 M 便宜');
  eq(p2.parts.length, 2, '两档');

  const p3 = api.lvPlanBuy(20000, null, 30000, 20000);
  eq(p3.affordable, false, '只剩 10,000 可用就不够');
  eq(p3.maxQty, 1, '能买 1 颗最大那档');

  eq(api.lvPlanBuy(0, null, 999999, 0).ok, false, '不缺经验就不买');
  eq(api.lvPlanBuy(5000, null, 10000, 20000).ok, false, '金钱低于保留线不买');

  /* 文案：按拆好的档位拼给人看 */
  eq(api.lvPlanText(bd1), '1×经验糖XL + 1×经验糖M', '提示里写清买几颗哪种');

  /* 批量连点的安全上限：点完不越级才算安全，否则退化成一颗一颗 */
  eq(api.lvBurstCount(300000, 150000, 5, 10), 2, '缺 30 万、单颗 15 万 → 最多连点 2 颗');
  eq(api.lvBurstCount(159000, 600, 100, 10), 10, '小糖便宜，但批次上限 10 颗');
  eq(api.lvBurstCount(159000, 600, 3, 10), 3, '只有 3 颗就最多点 3 颗');
  eq(api.lvBurstCount(100, 600, 50, 10), 0, '缺口比单颗还小 → 不批量，交给单颗收尾');
  eq(api.lvBurstCount(150000, 150000, 9, 10), 1, '刚好一颗的量只点 1 颗，绝不越级');
  eq(api.lvBurstCount(0, 600, 50, 10), 0, '不缺经验就不点');
  eq(api.lvBurstCount(159000, 600, 0, 10), 0, '没货就不点');
}

/* ---------------- 汇总 ---------------- */

console.log(`\n通过 ${pass} 项`);
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项：');
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('✅ 3.7 / 3.8 新增逻辑全部通过');
