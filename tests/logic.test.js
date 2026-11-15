/**
 * 3.7.0 新增逻辑的离线自测（不依赖浏览器 / 油猴）
 *
 * 做法：把 userscript 里「商店补货 → 培育屋监控」这一段源码切出来，
 * 用一个假的运行环境（S / localStorage / document / fire）包起来跑，
 * 这样改逻辑时不用开游戏就能先验一遍。
 *
 *   node tests/logic.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'pokecatch-autofarm.user.js');
const source = fs.readFileSync(SRC, 'utf8');

const START = '/* ====================== 模块：商店自动补货';
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
    }, opts.cfg || {}),
    keepAliveOn: false,
    save: opts.save || null,
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
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
    fmt: (n) => String(Math.round(n || 0)),
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
    return { shopPlan, autoShop, settleShop, shopDiag, ledgerTick, ledgerAdd, ledgerToday, ledgerData,
             ledgerCsv, dayKey, dexGap, dexGapText, daycareState, daycareTick, dailyReportText, NEW_DAY };`);
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

/* ---------------- 1. 补货清单 ---------------- */

{
  const save = { money: 50000, items: {
    'razz-berry': 5, 'starf-berry': 1, 'enigma-berry': 9, 'nanab-berry': 4,
    'golden-razz-berry': 3, 'pinap-berry': 7, 'lansat-berry': 6, 'exp-candy-s': 0,
  } };
  const env = makeEnv({ save });
  const plan = env.api.shopPlan(save, {
    berryFamilies: { shiny: true, dex: true, rare: true, capture: true, xp: true, money: true },
    shopKeepBerries: 3, shopKeepCandy: 0,
  });
  eq(plan.length, 1, '只补库存不足的那一种');
  eq(plan[0].id, 'starf-berry', '缺口是 starf-berry');
  eq(plan[0].need, 2, 'starf-berry 缺 2 颗');

  /* 关掉 xp family 后，pinap 不进清单 */
  const plan2 = env.api.shopPlan({ items: { 'pinap-berry': 0 } }, {
    berryFamilies: { xp: false }, shopKeepBerries: 3, shopKeepCandy: 0,
  });
  ok(!plan2.some((p) => p.id === 'pinap-berry'), 'family 关闭的树果不补');

  /* 糖果：只挑一个最缺的档 */
  const plan3 = env.api.shopPlan({ items: { 'exp-candy-s': 0, 'exp-candy-m': 0 } }, {
    berryFamilies: {}, shopKeepBerries: 0, shopKeepCandy: 4,
  });
  eq(plan3.length, 1, '糖果只补一种');
  eq(plan3[0].id, 'exp-candy-xl', '糖果按 xl→s 优先级取第一个缺口');
}

/* ---------------- 2. autoShop 的防护与点击顺序 ---------------- */

function mockShopDom(rows) {
  const buyBtn = { tag: 'buy', disabled: false };
  const seg1 = { tag: 'seg1', classList: { contains: () => false } };
  const rowById = new Map(rows.map((r) => [r.id, {
    tag: r.id,
    dataset: { id: r.id },
    disabled: false,
    classList: { contains: (c) => (r.locked ? c === 'locked' : false) },
    querySelector: (sel) => (sel === '.sh-buy button.buy' ? buyBtn : sel === '.sh-lock, .sh-find' ? null : null),
    querySelectorAll: (sel) => (sel === '.sh-buy .seg button' ? [seg1] : []),
  }]));
  return {
    buyBtn,
    document: {
      querySelector: (sel) => {
        if (sel === '#shop-grid') return {};
        if (sel === '[data-go="shop"]') return null;
        if (sel === '#screen-shop [data-sh-mode="buy"]') return { classList: { contains: () => true } };
        const m = /#shop-grid \.sh-item\[data-id="(.+)"\]/.exec(sel);
        if (m) return rowById.get(m[1]) || null;
        return null;
      },
      querySelectorAll: () => [],
    },
  };
}

{
  const save = { money: 5000, items: { 'razz-berry': 0 } };
  const env = makeEnv({ save, cfg: { shopKeepBerries: 3, shopKeepCandy: 0, shopMoneyFloor: 1000, shopDailyCap: 0 } });
  const dom = mockShopDom([{ id: 'starf-berry' }, { id: 'razz-berry' }]);
  env.document = dom.document;
  /* 重建闭包里的 document 引用 */
  env.api = new Function(...Object.keys(env).filter((k) => k !== 'api'),
      `${moduleCode}\n return { autoShop };`)(...Object.keys(env).filter((k) => k !== 'api').map((k) => env[k]));

  env.clock = 1000;
  env.api.autoShop(true);
  ok(env.fired.includes(dom.buyBtn), '余额充足时点了购买按钮');
  ok(env.fired.some((el) => el.tag === 'seg1'), '没选中数量档位时先点 ×1');
  eq(env.logs.filter((l) => l.includes('补货待命')).length, 0, '商店开着就不提示待命');

  /* 余额保护 */
  const poor = makeEnv({ save: { money: 500, items: { 'razz-berry': 0 } }, cfg: { shopMoneyFloor: 1000 } });
  poor.document = mockShopDom([{ id: 'razz-berry' }]).document;
  poor.api = new Function(...Object.keys(poor).filter((k) => k !== 'api'),
      `${moduleCode}\n return { autoShop };`)(...Object.keys(poor).filter((k) => k !== 'api').map((k) => poor[k]));
  poor.clock = 1000;
  poor.api.autoShop(true);
  eq(poor.fired.length, 0, '金钱低于下限一颗都不买');

  /* 锁住的行不点 */
  const locked = makeEnv({ save: { money: 90000, items: { 'starf-berry': 0 } }, cfg: { shopKeepBerries: 3, shopMoneyFloor: 1000 } });
  const ldom = mockShopDom([{ id: 'starf-berry', locked: true }]);
  locked.document = ldom.document;
  locked.api = new Function(...Object.keys(locked).filter((k) => k !== 'api'),
      `${moduleCode}\n return { autoShop };`)(...Object.keys(locked).filter((k) => k !== 'api').map((k) => locked[k]));
  locked.clock = 1000;
  locked.api.autoShop(true);
  ok(!locked.fired.includes(ldom.buyBtn), '徽章未解锁的行不会被点');
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

/* ---------------- 汇总 ---------------- */

console.log(`\n通过 ${pass} 项`);
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项：');
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('✅ 3.7.0 新增逻辑全部通过');
