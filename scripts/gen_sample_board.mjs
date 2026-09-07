import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 读取存储根目录（从 %APPDATA%\Lumen\config.json）
const cfgPath = path.join(process.env.APPDATA || '', 'Lumen', 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const root = cfg.storage_root;
if (!root) throw new Error('storage_root 未设置');
fs.mkdirSync(root, { recursive: true });
console.log('storage_root =', root);

const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const rid = (p) => `${p}_${Date.now().toString(16)}${Math.floor(Math.random() * 1e6).toString(16)}`;

// ── index.json：追加项目，不破坏已有 ──
const indexPath = path.join(root, 'index.json');
let index = { version: 1, projects: [] };
if (fs.existsSync(indexPath)) {
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch {}
}
if (!Array.isArray(index.projects)) index.projects = [];

const projectId = rid('p');
const projectName = '示例 · 丝绸之路';
index.projects.push({ id: projectId, name: projectName, created_at: now });

const projectDir = path.join(root, projectId);
fs.mkdirSync(projectDir, { recursive: true });

const boardId = rid('b');
const boardName = '丝绸之路：一条商路如何连接文明';

// project.json
const projectFile = {
  version: 1,
  id: projectId,
  name: projectName,
  created_at: now,
  updated_at: now,
  boards: [{ id: boardId, name: boardName, updated_at: now }],
};
fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify(projectFile, null, 2));

const boardDir = path.join(projectDir, boardId);
const docsDir = path.join(boardDir, 'docs');
fs.mkdirSync(docsDir, { recursive: true });

// ── 文档：每篇 Markdown（含标题层级、表格、公式、列表）──
const docs = {
  'overview.md': `# 丝绸之路总览

**丝绸之路**（Silk Road）是古代连接**东亚**与**地中海世界**的贸易与文化通道网络，得名于其上最著名的商品——中国丝绸。这一名称由德国地理学家**李希霍芬**（Ferdinand von Richthofen）于 1877 年首次提出。

## 它到底是什么

它并非一条路，而是一张**路网**：陆上有绿洲线、草原线，海上有季风航线。商品、宗教、技术、疾病都沿着它流动。

> "丝绸之路运送的从来不只是丝绸，而是整个欧亚大陆的观念。"

## 时间尺度

| 时期 | 大致年代 | 主导力量 |
| --- | --- | --- |
| 开辟期 | 前 2 世纪 | 汉朝（张骞出使） |
| 鼎盛期 | 7–9 世纪 | 唐朝与阿拉伯帝国 |
| 海路兴起 | 10–13 世纪 | 宋元与阿拉伯航海 |
| 衰落期 | 15 世纪后 | 大航海取代陆路 |

## 关键问题

- 为什么一条商路能延续一千多年？
- 它如何改变了它所触及的每一种文明？
`,

  'zhangqian.md': `# 张骞凿空西域

## 出使背景

公元前 138 年，**汉武帝**为联合**大月氏**夹击匈奴，派**张骞**出使西域。张骞两次被匈奴扣留，前后历时十三年，归汉时仅余二人。

虽然军事联盟未成，但他带回了对西域三十六国的第一手认识，史称**"凿空"**。

## 带回了什么

1. 地理知识：葱岭以西的城邦、物产、道路
2. 物种：苜蓿、葡萄等随后传入中原
3. 战略视野：汉朝由此经营河西走廊，设**河西四郡**

## 一个估算

若商队日行约 30 里，从长安到疏勒（约 4000 里）单程约需：

$$t = \\frac{4000}{30} \\approx 133 \\text{ 天}$$

这还不含翻越葱岭与补给休整——可见一次往返动辄以**年**计。
`,

  'religion.md': `# 沿路传播的宗教

丝绸之路是古代最重要的**信仰高速公路**。

## 佛教东传

佛教自**贵霜帝国**经西域传入中国。沿途的石窟艺术是它最壮观的遗产：

- **敦煌莫高窟**：跨越千年的壁画与塑像
- **克孜尔石窟**：龟兹地区的早期佛教艺术
- **云冈 / 龙门**：佛教中国化的里程碑

## 多信仰并存

除佛教外，还有：

| 宗教 | 传入方向 | 遗存 |
| --- | --- | --- |
| 祆教（拜火教） | 波斯 → 中原 | 粟特人聚落 |
| 摩尼教 | 波斯 → 回鹘 | 唐代寺院 |
| 景教（基督教聂斯脱里派） | 叙利亚 → 长安 | 《大秦景教流行中国碑》 |

粟特商人（**Sogdians**）既是商队主力，也是信仰与文字的传播者。
`,

  'goods.md': `# 商品与技术的双向流动

丝绸之路上的交换是**双向**的——中原并非只输出。

## 东去西来

**由东向西**：丝绸、瓷器、造纸术、火药、指南针
**由西向东**：良马、宝石、玻璃器、香料、乐器、作物

## 造纸术西传：一个转折点

751 年**怛罗斯之战**后，唐军战俘中的造纸工匠把技术带到**撒马尔罕**，再经巴格达传入欧洲，深远影响了此后的知识传播。

## 贸易规模的粗略模型

设一支商队有 $n$ 峰骆驼，每峰载货 $m$ 公斤，则单次运力：

$$W = n \\times m$$

以 $n = 100$、$m = 150\\,\\text{kg}$ 计，$W = 15\\,000\\,\\text{kg}$，即约 **15 吨**。丝绸价值极高、重量极轻，正是长途贸易的理想货物。
`,

  'decline.md': `# 陆路的衰落与海路的兴起

## 为什么陆路衰落

1. **政治碎片化**：蒙古帝国瓦解后，沿线安全不再有统一保障
2. **成本**：陆运受制于补给、关税与盗匪，单位成本高
3. **技术替代**：远洋帆船 + 季风航线运力更大、更廉价

## 海上丝绸之路

宋元时期，**泉州**、**广州**成为世界级港口，瓷器沿海路大量外销，故海路又称**"陶瓷之路"**。

## 大航海的终局

15 世纪末，达伽马绕过好望角、哥伦布西航，欧洲直接掌握了通往东方的海路，古老的陆上商路逐渐沉寂。但它留下的**文明交流的遗产**，从未消失。
`,
};

const docRefs = {};
for (const [name, content] of Object.entries(docs)) {
  fs.writeFileSync(path.join(docsDir, name), content, 'utf8');
  docRefs[name] = {
    path: `docs/${name}`,
    title: content.split('\n')[0].replace(/^#\s*/, ''),
    bytes: Buffer.byteLength(content, 'utf8'),
  };
}

// ── 节点：在画布上布局成一棵"问题树" ──
const nodes = [
  { key: 'root', title: '丝绸之路：一条商路如何连接文明？', summary: '总览：路网、时间尺度与核心问题', x: 380, y: 60, color: '#2f9e77', docs: ['overview.md'] },
  { key: 'origin', title: '起点：张骞凿空西域', summary: '汉武帝时的外交与地理大发现', x: 80, y: 300, color: '#3b82c4', docs: ['zhangqian.md'] },
  { key: 'religion', title: '信仰的高速公路', summary: '佛教东传与多宗教并存', x: 360, y: 320, color: '#b3782c', docs: ['religion.md'] },
  { key: 'goods', title: '商品与技术双向流动', summary: '丝绸、瓷器、造纸术、良马、香料', x: 650, y: 300, color: '#8a5cf6', docs: ['goods.md'] },
  { key: 'decline', title: '陆路衰落与海路兴起', summary: '大航海如何取代古商道', x: 380, y: 580, color: '#c95a4f', docs: ['decline.md'] },
];

const nodeObjs = nodes.map((n) => ({
  id: rid('n'),
  title: n.title,
  summary: n.summary,
  x: n.x,
  y: n.y,
  w: 260,
  color: n.color,
  docs: n.docs.map((d) => docRefs[d]),
  created_at: now,
  updated_at: now,
}));
const byKey = Object.fromEntries(nodes.map((n, i) => [n.key, nodeObjs[i].id]));

const mkEdge = (from, to, label) => ({
  id: rid('e'),
  from: byKey[from],
  to: byKey[to],
  directed: true,
  label,
  created_at: now,
});
const edges = [
  mkEdge('root', 'origin', '如何开始'),
  mkEdge('root', 'religion', '传播了什么'),
  mkEdge('root', 'goods', '交换了什么'),
  mkEdge('root', 'decline', '如何结束'),
  mkEdge('goods', 'decline', '技术替代'),
];

const boardFile = {
  version: 1,
  id: boardId,
  name: boardName,
  projectId: projectId,
  created_at: now,
  updated_at: now,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: nodeObjs,
  edges,
};
fs.writeFileSync(path.join(boardDir, 'board.json'), JSON.stringify(boardFile, null, 2));

// 最后写 index.json（原子性：先写临时再改名）
const tmp = indexPath + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
fs.renameSync(tmp, indexPath);

console.log('OK 生成项目：', projectName);
console.log('OK 生成白板：', boardName, `(${nodeObjs.length} 节点, ${edges.length} 连线, ${Object.keys(docs).length} 文档)`);
